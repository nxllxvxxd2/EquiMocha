/*
 * EquiMocha
 * Based directly on Equicord's fileUpload plugin flow, with Mocha as the only uploader.
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { OpenExternalIcon } from "@components/Icons";
import { classNameFactory } from "@utils/css";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { DraftType, FluxDispatcher, Menu, PermissionsBits, PermissionStore, React, SelectedChannelStore, showToast, Toasts, useEffect, UserStore, useState } from "@webpack/common";

const cl = classNameFactory("vc-file-upload-");
const { getUserMaxFileSize } = findByPropsLazy("getUserMaxFileSize");
const Native = IS_DISCORD_DESKTOP
    ? VencordNative.pluginHelpers.EquiMocha as PluginNative<typeof import("./native")>
    : null;

const MOCHA_BASE = "https://mocha.my";
const MOCHA_SERVICE_LABEL = "Mocha";
const MOCHA_INTERCEPT_THRESHOLD = 9 * 1024 * 1024;
const DIRECT_UPLOAD_LIMIT = 50 * 1024 * 1024;
const CHUNK_SIZE = 10 * 1024 * 1024;
const PART_RETRIES = 3;

let uploadAddFilesInterceptor: ((event: unknown) => void) | null = null;
let pasteEventListener: ((event: ClipboardEvent) => void) | null = null;
let dragOverEventListener: ((event: DragEvent) => void) | null = null;
let dropEventListener: ((event: DragEvent) => void) | null = null;
let fileInputChangeEventListener: ((event: Event) => void) | null = null;

type UploadAddFilesEvent = {
    type: string;
    files?: unknown;
    uploads?: unknown;
    items?: unknown;
    draftType?: unknown;
    maxFileSize?: unknown;
    fileSizeLimit?: unknown;
    limits?: {
        fileSize?: unknown;
    };
    channelId?: unknown;
    guildId?: unknown;
};

type UploadPhase = "idle" | "preparing" | "uploading" | "retrying" | "success" | "failed" | "cancelled";

type UploadProgressState = {
    phase: UploadPhase;
    fileName: string;
    currentServiceLabel: string;
    attempt: number;
    totalAttempts: number;
    percent: number;
    transferredBytes: number;
    totalBytes: number;
    status: string;
    canCancel: boolean;
};

type NativeUploadProgress = {
    phase: UploadPhase | "sharing";
    percent: number;
    transferredBytes: number;
    totalBytes: number;
    partNumber: number;
    totalParts: number;
    status: string;
};

const settings = definePluginSettings({
    apiKey: {
        type: OptionType.STRING,
        description: "Mocha API Key",
        default: "",
        placeholder: "mocha_xxxxxxxxx"
    },
    autoSend: {
        type: OptionType.BOOLEAN,
        description: "Automatically send uploaded links",
        default: true
    },
    autoUploadPastedFiles: {
        type: OptionType.BOOLEAN,
        description: "Automatically upload pasted files to Mocha",
        default: true
    },
    bypassDiscordUpload: {
        type: OptionType.BOOLEAN,
        description: "Bypass Discord upload and upload attachments to Mocha",
        default: true
    },
    bypassDiscordUploadOnlyOverLimit: {
        type: OptionType.BOOLEAN,
        description: "Only bypass Discord upload when a file is over Discord's upload limit",
        default: true
    },
    shareExpiry: {
        type: OptionType.SELECT,
        description: "Share expiry",
        default: "never",
        options: [
            { label: "Never", value: "never" },
            { label: "1 day", value: "1d" },
            { label: "7 days", value: "7d" },
            { label: "30 days", value: "30d" }
        ]
    },
    debug: {
        type: OptionType.BOOLEAN,
        description: "Log Mocha upload requests and responses to the console",
        default: true
    }
});

const defaultUploadState: UploadProgressState = {
    phase: "idle",
    fileName: "",
    currentServiceLabel: "",
    attempt: 0,
    totalAttempts: 0,
    percent: 0,
    transferredBytes: 0,
    totalBytes: 0,
    status: "",
    canCancel: false
};

let isUploading = false;
let cancelRequested = false;
let uploadState: UploadProgressState = { ...defaultUploadState };
let activeAbortController: AbortController | null = null;
let activeXhr: XMLHttpRequest | null = null;
let activeNativeUploadKey: string | null = null;
const uploadStateListeners = new Set<() => void>();

function isConfigured(): boolean {
    return Boolean(settings.store.apiKey?.trim());
}

function emitUploadState() {
    for (const listener of uploadStateListeners) {
        listener();
    }
}

function setUploadState(patch: Partial<UploadProgressState>) {
    uploadState = { ...uploadState, ...patch };
    emitUploadState();
}

function resetUploadState() {
    uploadState = { ...defaultUploadState };
    emitUploadState();
}

function subscribeUploadState(listener: () => void): () => void {
    uploadStateListeners.add(listener);
    return () => uploadStateListeners.delete(listener);
}

function getUploadState(): UploadProgressState {
    return uploadState;
}

function cancelCurrentUpload() {
    if (!isUploading) {
        return;
    }

    cancelRequested = true;
    activeAbortController?.abort();
    activeXhr?.abort();
    if (activeNativeUploadKey && Native) {
        void Native.cancelUpload(activeNativeUploadKey);
    }
    setUploadState({
        phase: "cancelled",
        status: "Upload cancelled.",
        canCancel: false,
        percent: 0
    });
}

function coerceFileSizeLimit(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return value;
    }

    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    return null;
}

function getDiscordUploadLimit(payload?: UploadAddFilesEvent): number {
    const directLimit = [
        payload?.maxFileSize,
        payload?.fileSizeLimit,
        payload?.limits?.fileSize
    ].map(coerceFileSizeLimit).find((limit): limit is number => limit !== null);

    if (directLimit) return directLimit;

    const fallbackLimit = coerceFileSizeLimit(getUserMaxFileSize(UserStore.getCurrentUser()));

    return fallbackLimit ?? 10 * 1024 * 1024;
}

function shouldInterceptUploadFiles(files: readonly File[], payload: UploadAddFilesEvent): boolean {
    if (!settings.store.bypassDiscordUploadOnlyOverLimit) return true;

    const discordLimit = Math.min(getDiscordUploadLimit(payload), MOCHA_INTERCEPT_THRESHOLD);

    return files.some(file => file.size > discordLimit);
}

function isArrayLikeFileContainer(value: unknown): value is { length: number; [index: number]: unknown; } {
    return Boolean(
        value
        && typeof value === "object"
        && "length" in value
        && typeof value.length === "number"
        && Number.isFinite(value.length)
    );
}

function extractFilesFromValue(value: unknown, seen = new Set<unknown>()): File[] {
    if (!value || seen.has(value)) return [];
    if (value instanceof File) return [value];
    if (typeof value !== "object") return [];

    seen.add(value);

    if (Array.isArray(value)) {
        return value.flatMap(entry => extractFilesFromValue(entry, seen));
    }

    if (typeof DataTransferItem !== "undefined" && value instanceof DataTransferItem) {
        const file = value.kind === "file" ? value.getAsFile() : null;
        return file ? [file] : [];
    }

    if (isArrayLikeFileContainer(value)) {
        return Array.from({ length: value.length }, (_, index) => value[index])
            .flatMap(entry => extractFilesFromValue(entry, seen));
    }

    const entry = value as Record<string, unknown>;
    return [
        entry.file,
        entry.upload,
        entry.item,
        entry.fileItem,
        entry.uploadItem,
        entry.originalFile,
        entry.platformFile
    ].flatMap(candidate => extractFilesFromValue(candidate, seen));
}

function interceptUploadAddFiles(event: unknown): void {
    if (!event || typeof event !== "object" || !("type" in event)) return;

    const payload = event as UploadAddFilesEvent;
    if (payload.type !== "UPLOAD_ATTACHMENT_ADD_FILES") return;

    if (payload.draftType !== DraftType.ChannelMessage) return;

    if (!settings.store.bypassDiscordUpload || !isConfigured()) return;

    const files = [
        ...extractFilesFromValue(payload.files),
        ...extractFilesFromValue(payload.uploads),
        ...extractFilesFromValue(payload.items)
    ];
    const uniqueFiles = Array.from(new Set(files));

    if (!uniqueFiles.length) return;
    if (!shouldInterceptUploadFiles(uniqueFiles, payload)) return;

    payload.files = [];
    payload.uploads = [];
    payload.items = [];
    void uploadProvidedFiles(uniqueFiles);
}

function handlePaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length === 0) return;

    if (!settings.store.autoUploadPastedFiles || !isConfigured()) return;
    if (!shouldInterceptUploadFiles(files, {
        type: "PASTE",
        draftType: DraftType.ChannelMessage
    })) return;

    event.preventDefault();
    event.stopPropagation();

    void uploadProvidedFiles(files);
}

function getFilesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
    if (!dataTransfer) return [];

    return Array.from(new Set([
        ...Array.from(dataTransfer.files || []),
        ...extractFilesFromValue(dataTransfer.items)
    ]));
}

function stopDiscordFileEvent(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

function handleDragOver(event: DragEvent) {
    const files = getFilesFromDataTransfer(event.dataTransfer);
    if (!files.length) return;

    if (!settings.store.bypassDiscordUpload || !isConfigured()) return;
    if (!shouldInterceptUploadFiles(files, {
        type: "DROP",
        draftType: DraftType.ChannelMessage
    })) return;

    stopDiscordFileEvent(event);
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
    }
}

function handleDrop(event: DragEvent) {
    const files = getFilesFromDataTransfer(event.dataTransfer);
    if (!files.length) return;

    if (!settings.store.bypassDiscordUpload || !isConfigured()) return;
    if (!shouldInterceptUploadFiles(files, {
        type: "DROP",
        draftType: DraftType.ChannelMessage
    })) return;

    stopDiscordFileEvent(event);
    void uploadProvidedFiles(files);
}

function handleFileInputChange(event: Event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file") return;

    const files = Array.from(input.files || []);
    if (!files.length) return;

    if (!settings.store.bypassDiscordUpload || !isConfigured()) return;
    if (!shouldInterceptUploadFiles(files, {
        type: "FILE_INPUT",
        draftType: DraftType.ChannelMessage
    })) return;

    stopDiscordFileEvent(event);
    input.value = "";
    void uploadProvidedFiles(files);
}

function formatBytes(bytes: number): string {
    if (!bytes) return "";

    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function today(): string {
    return new Date().toISOString().split("T")[0];
}

function expiryHours(value: string): number | null {
    const map: Record<string, number> = {
        "1d": 24,
        "7d": 168,
        "30d": 720
    };

    return map[value] ?? null;
}

function authHeaders(extra: Record<string, string> = {}) {
    return {
        Authorization: `Bearer ${settings.store.apiKey.trim()}`,
        ...extra
    };
}

function debugLog(...args: unknown[]) {
    if (!settings.store.debug) return;

    console.log("[EquiMocha Debug]", ...args);
}

async function debugResponse(label: string, response: Response) {
    if (!settings.store.debug) return;

    const body = await response.clone().text().catch(error => `Could not read response body: ${String(error)}`);

    debugLog(label, {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        body
    });
}

function isUploadCancelledError(error: unknown): boolean {
    if (cancelRequested) return true;
    if (!(error instanceof Error)) return false;

    const message = error.message.toLowerCase();
    return message.includes("cancelled") || message.includes("canceled") || message.includes("aborted") || message.includes("aborterror");
}

async function fetchWithAbort(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    activeAbortController = controller;
    const method = options.method || "GET";

    debugLog("fetch start", {
        method,
        url,
        bodyType: options.body ? options.body.constructor?.name : null
    });

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });

        await debugResponse(`fetch complete ${method} ${url}`, response);

        return response;
    } catch (error) {
        debugLog("fetch error", {
            method,
            url,
            error
        });

        if (cancelRequested || controller.signal.aborted) {
            throw new Error(cancelRequested ? "Upload cancelled by user" : "Upload aborted");
        }

        throw error;
    } finally {
        if (activeAbortController === controller) {
            activeAbortController = null;
        }
    }
}

function getHeaderEntries(headers?: HeadersInit): [string, string][] {
    if (!headers) return [];
    if (headers instanceof Headers) return Array.from(headers.entries());
    if (Array.isArray(headers)) return headers.map(([key, value]) => [key, value]);

    return Object.entries(headers);
}

function uploadRequest(url: string, options: RequestInit, onProgress?: (event: ProgressEvent) => void): Promise<XMLHttpRequest> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        activeXhr = xhr;
        const method = options.method || "GET";

        debugLog("xhr start", {
            method,
            url,
            bodyType: options.body ? options.body.constructor?.name : null
        });

        xhr.open(method, url);

        for (const [key, value] of getHeaderEntries(options.headers)) {
            xhr.setRequestHeader(key, value);
        }

        xhr.upload.onprogress = event => onProgress?.(event);
        xhr.onload = () => {
            debugLog("xhr complete", {
                method,
                url,
                status: xhr.status,
                statusText: xhr.statusText,
                response: xhr.responseText
            });

            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr);
            } else {
                reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
            }
        };
        xhr.onerror = () => {
            debugLog("xhr error", {
                method,
                url,
                status: xhr.status,
                statusText: xhr.statusText,
                response: xhr.responseText
            });

            reject(new Error("Upload failed"));
        };
        xhr.onabort = () => {
            debugLog("xhr abort", {
                method,
                url,
                status: xhr.status,
                statusText: xhr.statusText,
                response: xhr.responseText
            });

            reject(new Error(cancelRequested ? "Upload cancelled by user" : "Upload aborted"));
        };
        xhr.onloadend = () => {
            xhr.upload.onprogress = null;
            if (activeXhr === xhr) {
                activeXhr = null;
            }
        };

        const { body } = options;
        xhr.send(body instanceof ReadableStream ? null : body as XMLHttpRequestBodyInit | null);
    });
}

async function ensureFolder(path: string) {
    const parts = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

    for (let i = 0; i < parts.length; i++) {
        if (cancelRequested) throw new Error("Upload cancelled by user");

        const parent = `/${parts.slice(0, i).join("/")}`.replace(/\/$/, "") || "/";
        const name = parts[i];

        const response = await fetchWithAbort(`${MOCHA_BASE}/api/files/folders`, {
            method: "POST",
            headers: authHeaders({
                "Content-Type": "application/json"
            }),
            body: JSON.stringify({
                path: parent,
                name
            })
        });

        if (!response.ok && response.status !== 409) {
            throw new Error(`Failed creating Mocha folder: ${response.status} ${await response.text()}`);
        }
    }
}

function getFileId(data: any): string {
    const fileId = data?.fileId ?? data?.id ?? data?.file?.id;

    if (!fileId) {
        throw new Error("No file id returned from Mocha");
    }

    return String(fileId);
}

async function uploadDirect(fileBlob: Blob, filename: string, destinationFolder: string): Promise<string> {
    const startTime = Date.now();
    const xhr = await uploadRequest(`${MOCHA_BASE}/api/files`, {
        method: "POST",
        headers: authHeaders({
            "x-file-name": filename,
            "x-file-path": `${destinationFolder}/`,
            "x-file-type": fileBlob.type || "application/octet-stream"
        }),
        body: fileBlob
    }, event => {
        if (!event.lengthComputable || event.total <= 0) return;

        const elapsed = Math.max((Date.now() - startTime) / 1000, 0.001);
        setUploadState({
            phase: "uploading",
            percent: Math.round(Math.max(0, Math.min(99, event.loaded / event.total * 100))),
            transferredBytes: event.loaded,
            totalBytes: event.total,
            status: `Uploading via ${MOCHA_SERVICE_LABEL}...`
        });
    });

    return getFileId(JSON.parse(xhr.responseText));
}

async function uploadMultipart(fileBlob: Blob, filename: string, destinationFolder: string): Promise<string> {
    const mimeType = fileBlob.type || "application/octet-stream";
    const remotePath = `${destinationFolder}/`;
    const initResponse = await fetchWithAbort(`${MOCHA_BASE}/api/files/multipart/init`, {
        method: "POST",
        headers: authHeaders({
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            originalName: filename,
            path: remotePath,
            size: fileBlob.size,
            mimeType,
            strategy: "s3",
            partSizeBytes: CHUNK_SIZE
        })
    });

    if (!initResponse.ok) {
        throw new Error(`Multipart init failed: ${initResponse.status} ${await initResponse.text()}`);
    }

    const initData = await initResponse.json();

    if (initData.strategy !== "s3") {
        throw new Error(`Expected S3 multipart strategy but server returned: ${initData.strategy}`);
    }

    const session = {
        strategy: "s3" as const,
        uploadId: String(initData.uploadId),
        key: String(initData.key),
        nodeId: String(initData.nodeId),
        originalName: filename,
        path: remotePath
    };

    if (!session.uploadId || !session.key || !session.nodeId) {
        throw new Error(`Invalid multipart init response: ${JSON.stringify(initData)}`);
    }

    const totalParts = Math.ceil(fileBlob.size / CHUNK_SIZE);
    const parts: Array<{ partNumber: number; etag: string; }> = [];
    let totalUploaded = 0;

    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        if (cancelRequested) throw new Error("Upload cancelled by user");

        const offset = (partNumber - 1) * CHUNK_SIZE;
        const chunk = fileBlob.slice(offset, Math.min(fileBlob.size, offset + CHUNK_SIZE));

        for (let attempt = 1; attempt <= PART_RETRIES; attempt++) {
            try {
                setUploadState({
                    phase: attempt === 1 ? "uploading" : "retrying",
                    attempt: partNumber,
                    totalAttempts: totalParts,
                    status: attempt === 1
                        ? `Uploading via ${MOCHA_SERVICE_LABEL}...`
                        : `Retrying part ${partNumber}/${totalParts} via ${MOCHA_SERVICE_LABEL}...`
                });

                // Fetch presigned S3 URL for this part
                const presignResponse = await fetchWithAbort(`${MOCHA_BASE}/api/files/multipart/presigned`, {
                    method: "POST",
                    headers: authHeaders({
                        "Content-Type": "application/json"
                    }),
                    body: JSON.stringify({
                        ...session,
                        partNumbers: [partNumber],
                        expiresInSeconds: 3600
                    })
                });

                if (!presignResponse.ok) {
                    throw new Error(`Presign part ${partNumber} failed: ${presignResponse.status} ${await presignResponse.text()}`);
                }

                const presignData = await presignResponse.json();
                const presignedUrl: string | undefined =
                    typeof presignData?.url === "string" ? presignData.url
                    : typeof presignData?.presignedUrl === "string" ? presignData.presignedUrl
                    : Array.isArray(presignData?.urls)
                        ? presignData.urls.find((e: any) => e?.partNumber === partNumber)?.url
                        : undefined;

                if (!presignedUrl) {
                    throw new Error(`No presigned URL returned for part ${partNumber}`);
                }

                let previousLoaded = 0;
                const xhr = await uploadRequest(presignedUrl, {
                    method: "PUT",
                    headers: {},
                    body: chunk
                }, event => {
                    if (!event.lengthComputable) return;

                    const delta = event.loaded - previousLoaded;
                    previousLoaded = event.loaded;
                    totalUploaded += delta;

                    setUploadState({
                        phase: "uploading",
                        percent: Math.round(Math.max(0, Math.min(99, totalUploaded / fileBlob.size * 100))),
                        transferredBytes: totalUploaded,
                        totalBytes: fileBlob.size,
                        status: `Uploading via ${MOCHA_SERVICE_LABEL}...`
                    });
                });

                const etag = xhr.getResponseHeader("ETag");
                if (!etag) {
                    throw new Error(`No ETag returned for part ${partNumber}`);
                }

                parts.push({ partNumber, etag });
                break;
            } catch (error) {
                if (attempt === PART_RETRIES) {
                    throw error;
                }

                await new Promise(resolve => setTimeout(resolve, attempt * 1000));
            }
        }
    }

    const completeResponse = await fetchWithAbort(`${MOCHA_BASE}/api/files/multipart/complete`, {
        method: "POST",
        headers: authHeaders({
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            ...session,
            size: fileBlob.size,
            mimeType,
            parts: parts.sort((a, b) => a.partNumber - b.partNumber)
        })
    });

    if (!completeResponse.ok) {
        throw new Error(`Multipart completion failed: ${completeResponse.status} ${await completeResponse.text()}`);
    }

    return getFileId(await completeResponse.json());
}

async function createShare(fileId: string): Promise<string> {
    const payload: Record<string, unknown> = { fileId };
    const hours = expiryHours(settings.store.shareExpiry);

    if (hours !== null) {
        payload.expiresInHours = hours;
    }

    const response = await fetchWithAbort(`${MOCHA_BASE}/api/shares`, {
        method: "POST",
        headers: authHeaders({
            "Content-Type": "application/json"
        }),
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`Failed creating Mocha share: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const token = data?.token ?? data?.share?.token;

    if (!token) {
        throw new Error("No share token returned from Mocha");
    }

    return `${MOCHA_BASE}/share/${token}`;
}

function getFilenameFromBlob(fileBlob: Blob, sourceUrl?: string): string {
    if (fileBlob instanceof File && fileBlob.name) {
        return fileBlob.name;
    }

    if (sourceUrl && URL.canParse(sourceUrl)) {
        const segment = new URL(sourceUrl).pathname.split("/").pop();
        if (segment) return decodeURIComponent(segment);
    }

    return "upload.bin";
}

function getNativeFilePath(fileBlob: Blob): string | null {
    const path = (fileBlob as Blob & { path?: unknown; }).path;
    return typeof path === "string" && path.length > 0 ? path : null;
}

function createUploadKey(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function applyNativeProgress(progress: NativeUploadProgress | null) {
    if (!progress) return;

    setUploadState({
        phase: progress.phase === "sharing" ? "uploading" : progress.phase,
        attempt: progress.partNumber,
        totalAttempts: progress.totalParts,
        percent: progress.percent,
        transferredBytes: progress.transferredBytes,
        totalBytes: progress.totalBytes,
        status: progress.status,
        canCancel: progress.phase !== "success" && progress.phase !== "failed" && progress.phase !== "cancelled"
    });
}

async function uploadToMocha(fileBlob: Blob, filename: string): Promise<string> {
    if (Native) {
        const uploadKey = createUploadKey();
        activeNativeUploadKey = uploadKey;
        const progressTimer = setInterval(() => {
            void Native.getUploadProgress(uploadKey)
                .then(progress => {
                    if (activeNativeUploadKey === uploadKey) {
                        applyNativeProgress(progress);
                    }
                })
                .catch(error => debugLog("native progress poll failed", error));
        }, 250);

        debugLog("native upload start", {
            filename,
            size: fileBlob.size,
            mimeType: fileBlob.type || "application/octet-stream"
        });

        try {
            const nativePath = getNativeFilePath(fileBlob);
            const result = nativePath
                ? await Native.uploadPathToMocha(
                    nativePath,
                    filename,
                    fileBlob.type || "application/octet-stream",
                    settings.store.apiKey.trim(),
                    settings.store.shareExpiry,
                    uploadKey
                )
                : await Native.uploadToMocha(
                    await fileBlob.arrayBuffer(),
                    filename,
                    fileBlob.type || "application/octet-stream",
                    settings.store.apiKey.trim(),
                    settings.store.shareExpiry,
                    uploadKey
                );

            const finalProgress = await Native.getUploadProgress(uploadKey).catch(() => null);
            applyNativeProgress(finalProgress);

            debugLog("native upload result", result);

            if (!result.success || !result.url) {
                throw new Error(result.error || "Native Mocha upload failed");
            }

            return result.url;
        } finally {
            clearInterval(progressTimer);
            if (activeNativeUploadKey === uploadKey) {
                activeNativeUploadKey = null;
            }
        }
    }

    throw new Error("EquiMocha requires the Discord desktop native helper because Mocha blocks browser CORS requests.");
}

async function uploadPathToMocha(filePath: string, filename: string, mimeType = "application/octet-stream"): Promise<string> {
    if (!Native) {
        throw new Error("EquiMocha requires the Discord desktop native helper because Mocha blocks browser CORS requests.");
    }

    const uploadKey = createUploadKey();
    activeNativeUploadKey = uploadKey;
    const progressTimer = setInterval(() => {
        void Native.getUploadProgress(uploadKey)
            .then(progress => {
                if (activeNativeUploadKey === uploadKey) {
                    applyNativeProgress(progress);
                }
            })
            .catch(error => debugLog("native progress poll failed", error));
    }, 250);

    try {
        const result = await Native.uploadPathToMocha(
            filePath,
            filename,
            mimeType,
            settings.store.apiKey.trim(),
            settings.store.shareExpiry,
            uploadKey
        );

        const finalProgress = await Native.getUploadProgress(uploadKey).catch(() => null);
        applyNativeProgress(finalProgress);

        debugLog("native path upload result", result);

        if (!result.success || !result.url) {
            throw new Error(result.error || "Native Mocha upload failed");
        }

        return result.url;
    } finally {
        clearInterval(progressTimer);
        if (activeNativeUploadKey === uploadKey) {
            activeNativeUploadKey = null;
        }
    }
}

async function uploadToMochaRenderer(fileBlob: Blob, filename: string): Promise<string> {
    const destinationFolder = `/discord/${today()}`;

    await ensureFolder(destinationFolder);

    const fileId = fileBlob.size <= DIRECT_UPLOAD_LIMIT
        ? await uploadDirect(fileBlob, filename, destinationFolder)
        : await uploadMultipart(fileBlob, filename, destinationFolder);

    setUploadState({
        status: "Creating Mocha share link...",
        percent: 99
    });

    return createShare(fileId);
}

async function notifyUploadSuccess(finalUrl: string): Promise<void> {
    showToast("Upload successful", Toasts.Type.SUCCESS);

    if (settings.store.autoSend) {
        sendMessage(SelectedChannelStore.getChannelId(), {
            content: finalUrl
        });
    }
}

async function uploadPreparedBlob(fileBlob: Blob, sourceUrl?: string): Promise<void> {
    const filename = getFilenameFromBlob(fileBlob, sourceUrl);
    setUploadState({
        phase: "uploading",
        fileName: filename,
        currentServiceLabel: MOCHA_SERVICE_LABEL,
        attempt: 1,
        totalAttempts: 1,
        percent: 0,
        transferredBytes: 0,
        totalBytes: fileBlob.size,
        status: `Preparing upload via ${MOCHA_SERVICE_LABEL}...`,
        canCancel: true
    });

    const uploadedUrl = await uploadToMocha(fileBlob, filename);

    setUploadState({
        phase: "success",
        percent: 100,
        transferredBytes: fileBlob.size,
        totalBytes: fileBlob.size,
        status: `Uploaded successfully via ${MOCHA_SERVICE_LABEL}.`,
        canCancel: false
    });

    await notifyUploadSuccess(uploadedUrl);
}

async function uploadFile(url: string): Promise<void> {
    if (isUploading) {
        showToast("Upload already in progress", Toasts.Type.MESSAGE);
        return;
    }

    if (!isConfigured()) {
        showToast("Please configure EquiMocha settings first", Toasts.Type.FAILURE);
        return;
    }

    isUploading = true;
    cancelRequested = false;
    setUploadState({
        phase: "preparing",
        fileName: "",
        currentServiceLabel: MOCHA_SERVICE_LABEL,
        attempt: 0,
        totalAttempts: 0,
        percent: 1,
        transferredBytes: 0,
        totalBytes: 0,
        status: "Preparing upload...",
        canCancel: true
    });

    try {
        const response = await fetchWithAbort(url, {
            method: "GET"
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch file: ${response.status}`);
        }

        await uploadPreparedBlob(await response.blob(), url);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        if (isUploadCancelledError(error)) {
            showToast("Upload cancelled", Toasts.Type.MESSAGE);
            setUploadState({ phase: "cancelled", status: "Upload cancelled.", canCancel: false, percent: 0 });
        } else {
            showToast(`Upload failed: ${message}`, Toasts.Type.FAILURE);
            console.error("[EquiMocha]", error);
            setUploadState({ phase: "failed", status: `Upload failed: ${message}`, canCancel: false, percent: 0 });
        }
    } finally {
        isUploading = false;
        activeAbortController = null;
        activeXhr = null;
        setTimeout(() => resetUploadState(), 1800);
    }
}

async function uploadPickedFile(): Promise<void> {
    if (!Native) {
        showToast("EquiMocha file selection requires Discord desktop", Toasts.Type.FAILURE);
        return;
    }

    if (isUploading) {
        showToast("Upload already in progress", Toasts.Type.MESSAGE);
        return;
    }

    if (!isConfigured()) {
        showToast("Please configure EquiMocha settings first", Toasts.Type.FAILURE);
        return;
    }

    const selectedFile = await Native.chooseFilePath();
    if (!selectedFile) return;

    isUploading = true;
    cancelRequested = false;

    setUploadState({
        phase: "preparing",
        fileName: selectedFile.name,
        currentServiceLabel: MOCHA_SERVICE_LABEL,
        attempt: 0,
        totalAttempts: 0,
        percent: 2,
        transferredBytes: 0,
        totalBytes: 0,
        status: `Preparing ${selectedFile.name}...`,
        canCancel: true
    });

    try {
        const uploadedUrl = await uploadPathToMocha(selectedFile.path, selectedFile.name);

        setUploadState({
            phase: "success",
            percent: 100,
            status: `Uploaded successfully via ${MOCHA_SERVICE_LABEL}.`,
            canCancel: false
        });

        await notifyUploadSuccess(uploadedUrl);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        if (isUploadCancelledError(error)) {
            showToast("Upload cancelled", Toasts.Type.MESSAGE);
            setUploadState({ phase: "cancelled", status: "Upload cancelled.", canCancel: false, percent: 0 });
        } else {
            showToast(`Upload failed: ${message}`, Toasts.Type.FAILURE);
            console.error("[EquiMocha]", error);
            setUploadState({ phase: "failed", status: `Upload failed: ${message}`, canCancel: false, percent: 0 });
        }
    } finally {
        isUploading = false;
        activeAbortController = null;
        activeXhr = null;
        setTimeout(() => resetUploadState(), 1800);
    }
}

async function uploadProvidedFiles(files: readonly File[]): Promise<void> {
    if (isUploading) {
        showToast("Upload already in progress", Toasts.Type.MESSAGE);
        return;
    }

    if (!isConfigured()) {
        showToast("Please configure EquiMocha settings first", Toasts.Type.FAILURE);
        return;
    }

    if (!files.length) return;

    const uploadFiles = files.filter(file => Boolean(file));
    if (!uploadFiles.length) return;

    isUploading = true;
    cancelRequested = false;

    try {
        for (let i = 0; i < uploadFiles.length; i++) {
            const file = uploadFiles[i];
            const current = i + 1;
            const suffix = uploadFiles.length > 1 ? ` (${current}/${uploadFiles.length})` : "";

            setUploadState({
                phase: "preparing",
                fileName: file.name,
                currentServiceLabel: MOCHA_SERVICE_LABEL,
                attempt: 0,
                totalAttempts: 0,
                percent: 2,
                transferredBytes: 0,
                totalBytes: file.size,
                status: `Preparing ${file.name}${suffix}...`,
                canCancel: true
            });

            await uploadPreparedBlob(file);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        if (isUploadCancelledError(error)) {
            showToast("Upload cancelled", Toasts.Type.MESSAGE);
            setUploadState({ phase: "cancelled", status: "Upload cancelled.", canCancel: false, percent: 0 });
        } else {
            showToast(`Upload failed: ${message}`, Toasts.Type.FAILURE);
            console.error("[EquiMocha]", error);
            setUploadState({ phase: "failed", status: `Upload failed: ${message}`, canCancel: false, percent: 0 });
        }
    } finally {
        isUploading = false;
        activeAbortController = null;
        activeXhr = null;
        setTimeout(() => resetUploadState(), 1800);
    }
}

function getMediaUrl(props: any): string | null {
    const src = props?.src ?? props?.itemSrc;
    const href = props?.href ?? props?.itemHref;
    const target = props?.target;

    if (typeof src === "string" && URL.canParse(src)) return src;
    if (typeof href === "string" && URL.canParse(href)) return href;
    if (target instanceof HTMLImageElement && URL.canParse(target.src)) return target.src;
    if (target instanceof HTMLVideoElement && URL.canParse(target.src)) return target.src;
    if (target instanceof HTMLAnchorElement && URL.canParse(target.href)) return target.href;

    return null;
}

const ProgressBarInner = () => {
    const [state, setState] = useState(getUploadState);

    useEffect(() => subscribeUploadState(() => setState(getUploadState())), []);

    if (state.phase === "idle") return null;

    const percentage = Math.max(0, Math.min(100, state.percent));
    const progressLabel = state.totalBytes > 0
        ? `${Math.round(percentage)}% - ${formatBytes(state.transferredBytes)} of ${formatBytes(state.totalBytes)}`
        : `${Math.round(percentage)}%`;

    return (
        <div
            className={cl("progress-wrap")}
            data-phase={state.phase}
        >
            <div className={cl("progress-head")}>
                <div className={cl("progress-label")}>
                    {state.status || "Uploading..."}
                </div>
                <div className={cl("progress-meta")}>
                    <span className={cl("progress-percent")}>
                        {progressLabel}
                    </span>
                    <span className={cl("progress-attempt")}>
                        {state.attempt > 0 && state.totalAttempts > 0 ? `${state.attempt}/${state.totalAttempts}` : ""}
                    </span>
                    {state.canCancel && (
                        <button
                            className={cl("progress-cancel")}
                            type="button"
                            onClick={cancelCurrentUpload}
                        >
                            Cancel
                        </button>
                    )}
                </div>
            </div>
            <div className={cl("progress-track")}>
                <div
                    className={cl("progress-fill")}
                    style={{ width: `${percentage}%` }}
                />
            </div>
            <div className={cl("progress-file")}>
                {state.fileName || ""}{state.currentServiceLabel ? ` • ${state.currentServiceLabel}` : ""}
            </div>
        </div>
    );
};

const ProgressBar = ErrorBoundary.wrap(ProgressBarInner, { noop: true });

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props) return;

    const { itemSrc, itemHref, target } = props;
    const url = getMediaUrl({ src: itemSrc, href: itemHref, target });

    if (!url) return;

    const group = findGroupChildrenByChildId("open-native-link", children)
        ?? findGroupChildrenByChildId("copy-link", children);

    if (group && !group.some(child => child?.props?.id === "file-upload")) {
        group.push(
            <Menu.MenuItem
                label={`Upload to ${MOCHA_SERVICE_LABEL}`}
                key="file-upload"
                id="file-upload"
                action={() => uploadFile(url)}
            />
        );
    }
};

const imageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props) return;

    if ("href" in props && !props.src) return;

    const url = getMediaUrl(props);
    if (!url) return;

    if (children.some(child => child?.props?.id === "file-upload-group")) return;

    children.push(
        <Menu.MenuGroup id="file-upload-group">
            <Menu.MenuItem
                label={`Upload to ${MOCHA_SERVICE_LABEL}`}
                key="file-upload"
                id="file-upload"
                action={() => uploadFile(url)}
            />
        </Menu.MenuGroup>
    );
};

const ExternalIcon = () => <OpenExternalIcon height={24} width={24} />;

const channelAttachMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel;
    if (!channel) return;
    if (channel.guild_id && !PermissionStore.can(PermissionsBits.SEND_MESSAGES, channel)) return;
    if (children.some(child => child?.props?.id === "file-upload-manual")) return;

    children.splice(1, 0,
        <Menu.MenuItem
            id="file-upload-manual"
            key="file-upload-manual"
            label="Upload to Mocha"
            iconLeft={ExternalIcon}
            leadingAccessory={{
                type: "icon",
                icon: ExternalIcon
            }}
            action={() => uploadPickedFile()}
        />
    );
};

export default definePlugin({
    name: "EquiMocha",
    description: "Upload images and videos to Mocha",
    tags: ["Media"],
    authors: [
        {
            name: "nxllxvxxd",
            id: 0n
        }
    ],
    settings,
    patches: [
        {
            find: ".CREATE_FORUM_POST||",
            replacement: {
                match: /(textValue:.{0,50}channelId:\i\.id\}\))(?:,\i(,))?/,
                replace: "$1,$self.renderUploadProgress()$2"
            }
        },
        // forces an early return on the file size limit nitro upsell modal
        {
            find: "#{intl::tRuxk9::raw}",
            replacement: {
                match: /(?<=MAX_FILE_SIZE_250_MB.{0,250})Array\.from\(\i\)\.some/,
                replace: "$self.shouldBypassDiscordUploadSizeCheck()?false:$&"
            }
        },
    ],
    contextMenus: {
        "message": messageContextMenuPatch,
        "image-context": imageContextMenuPatch,
        "channel-attach": channelAttachMenuPatch
    },
    start() {
        if (uploadAddFilesInterceptor) {
            return;
        }

        uploadAddFilesInterceptor = event => interceptUploadAddFiles(event);
        FluxDispatcher.addInterceptor(uploadAddFilesInterceptor);

        pasteEventListener = event => handlePaste(event);
        document.addEventListener("paste", pasteEventListener, true);

        dragOverEventListener = event => handleDragOver(event);
        dropEventListener = event => handleDrop(event);
        document.addEventListener("dragover", dragOverEventListener, true);
        document.addEventListener("drop", dropEventListener, true);

        fileInputChangeEventListener = event => handleFileInputChange(event);
        document.addEventListener("change", fileInputChangeEventListener, true);
    },
    stop() {
        if (!uploadAddFilesInterceptor) {
            return;
        }

        const index = FluxDispatcher._interceptors.indexOf(uploadAddFilesInterceptor);
        if (index > -1) {
            FluxDispatcher._interceptors.splice(index, 1);
        }

        uploadAddFilesInterceptor = null;

        if (pasteEventListener) {
            document.removeEventListener("paste", pasteEventListener, true);
            pasteEventListener = null;
        }

        if (dragOverEventListener) {
            document.removeEventListener("dragover", dragOverEventListener, true);
            dragOverEventListener = null;
        }

        if (dropEventListener) {
            document.removeEventListener("drop", dropEventListener, true);
            dropEventListener = null;
        }

        if (fileInputChangeEventListener) {
            document.removeEventListener("change", fileInputChangeEventListener, true);
            fileInputChangeEventListener = null;
        }
    },
    shouldBypassDiscordUploadSizeCheck(): boolean {
        return Boolean(settings.store.bypassDiscordUpload) && isConfigured();
    },
    renderUploadProgress() {
        return <ProgressBar />;
    }
});