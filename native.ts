import { IpcMainInvokeEvent } from "electron";

const MOCHA_BASE = "https://mocha.my";
const DIRECT_UPLOAD_LIMIT = 50 * 1024 * 1024;
const CHUNK_SIZE = 10 * 1024 * 1024;
const PART_RETRIES = 3;
const PART_UPLOAD_TIMEOUT_MS = 60 * 60 * 1000;
const STREAM_READ_SIZE = 64 * 1024;

type NativeUploadResult = {
    success: boolean;
    url?: string;
    error?: string;
};

type NativeUploadProgress = {
    phase: "preparing" | "uploading" | "retrying" | "sharing" | "success" | "failed" | "cancelled";
    percent: number;
    transferredBytes: number;
    totalBytes: number;
    partNumber: number;
    totalParts: number;
    status: string;
};

type NativeUploadSession = {
    progress: NativeUploadProgress;
    controller: AbortController;
    cancelled: boolean;
};

const activeUploads = new Map<string, NativeUploadSession>();

function today(): string {
    return new Date().toISOString().split("T")[0];
}

function authHeaders(apiKey: string, extra: Record<string, string> = {}) {
    return {
        Authorization: `Bearer ${apiKey}`,
        ...extra
    };
}

function expiryHours(value: string): number | null {
    const map: Record<string, number> = {
        "1d": 24,
        "7d": 168,
        "30d": 720
    };

    return map[value] ?? null;
}

function getUploadSession(uploadKey: string): NativeUploadSession {
    const session = activeUploads.get(uploadKey);

    if (!session) {
        throw new Error("Upload session is no longer active");
    }

    if (session.cancelled) {
        throw new Error("Upload cancelled by user");
    }

    return session;
}

function setProgress(uploadKey: string, patch: Partial<NativeUploadProgress>) {
    const session = activeUploads.get(uploadKey);
    if (!session) return;

    session.progress = {
        ...session.progress,
        ...patch
    };
}

function progressBody(source: ArrayBuffer, onLoaded: (loaded: number) => void): ReadableStream<Uint8Array> {
    const view = new Uint8Array(source);
    let offset = 0;

    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= view.byteLength) {
                controller.close();
                return;
            }

            const end = Math.min(offset + STREAM_READ_SIZE, view.byteLength);
            controller.enqueue(view.subarray(offset, end));
            offset = end;
            onLoaded(offset);
        }
    });
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = PART_UPLOAD_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromParent = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromParent, { once: true });

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal
        } as RequestInit);
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromParent);
    }
}

async function ensureFolder(apiKey: string, path: string) {
    const parts = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

    for (let i = 0; i < parts.length; i++) {
        const parent = `/${parts.slice(0, i).join("/")}`.replace(/\/$/, "") || "/";
        const name = parts[i];

        const response = await fetch(`${MOCHA_BASE}/api/files/folders`, {
            method: "POST",
            headers: authHeaders(apiKey, {
                "Content-Type": "application/json"
            }),
            body: JSON.stringify({
                path: parent,
                name
            })
        });

        if (!response.ok && response.status !== 409) {
            throw new Error(`Folder create failed: ${response.status} ${await response.text()}`);
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

async function uploadDirect(
    uploadKey: string,
    apiKey: string,
    fileBuffer: ArrayBuffer,
    filename: string,
    mimeType: string,
    destinationFolder: string
): Promise<string> {
    const uploadSession = getUploadSession(uploadKey);
    const response = await fetchWithTimeout(`${MOCHA_BASE}/api/files`, {
        method: "POST",
        signal: uploadSession.controller.signal,
        headers: authHeaders(apiKey, {
            "x-file-name": filename,
            "x-file-path": `${destinationFolder}/`,
            "x-file-type": mimeType,
            "Content-Length": String(fileBuffer.byteLength)
        }),
        duplex: "half",
        body: progressBody(fileBuffer, loaded => {
            setProgress(uploadKey, {
                phase: "uploading",
                percent: Math.min(99, Math.round(loaded / fileBuffer.byteLength * 100)),
                transferredBytes: loaded,
                totalBytes: fileBuffer.byteLength,
                partNumber: 1,
                totalParts: 1,
                status: "Uploading via Mocha..."
            });
        })
    } as RequestInit & { duplex: "half"; });

    getUploadSession(uploadKey);

    if (!response.ok) {
        throw new Error(`Direct upload failed: ${response.status} ${await response.text()}`);
    }

    return getFileId(await response.json());
}

async function getPresignedPartUrl(apiKey: string, session: any, partNumber: number): Promise<string> {
    const response = await fetchWithTimeout(`${MOCHA_BASE}/api/files/multipart/presigned`, {
        method: "POST",
        headers: authHeaders(apiKey, {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            ...session,
            partNumbers: [partNumber],
            expiresInSeconds: 3600
        })
    }, 30 * 1000);

    if (!response.ok) {
        throw new Error(`Presign part ${partNumber} failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    if (typeof data?.url === "string") return data.url;
    if (typeof data?.presignedUrl === "string") return data.presignedUrl;

    const partUrl = Array.isArray(data?.urls)
        ? data.urls.find((entry: any) => entry?.partNumber === partNumber)?.url
        : null;

    if (typeof partUrl !== "string") {
        throw new Error(`No presigned URL returned for part ${partNumber}`);
    }

    return partUrl;
}

async function uploadPart(
    uploadKey: string,
    apiKey: string,
    session: any,
    chunk: ArrayBuffer,
    partNumber: number,
    totalParts: number,
    completedBytes: number,
    totalBytes: number
): Promise<string> {
    const directS3 = session.strategy === "s3" && session.directUploadEnabled !== false;

    for (let attempt = 1; attempt <= PART_RETRIES; attempt++) {
        getUploadSession(uploadKey);

        try {
            setProgress(uploadKey, {
                phase: attempt === 1 ? "uploading" : "retrying",
                partNumber,
                totalParts,
                status: attempt === 1
                    ? `Uploading part ${partNumber}/${totalParts} via Mocha...`
                    : `Retrying part ${partNumber}/${totalParts} via Mocha...`
            });

            const requestUrl = directS3
                ? await getPresignedPartUrl(apiKey, session, partNumber)
                : (() => {
                    const partUrl = new URL(`${MOCHA_BASE}/api/files/multipart/part`);
                    partUrl.searchParams.set("strategy", String(session.strategy));
                    partUrl.searchParams.set("uploadId", String(session.uploadId));
                    partUrl.searchParams.set("key", String(session.key));
                    partUrl.searchParams.set("nodeId", String(session.nodeId));
                    partUrl.searchParams.set("originalName", String(session.originalName));
                    partUrl.searchParams.set("path", String(session.path));
                    partUrl.searchParams.set("partNumber", String(partNumber));
                    return partUrl.toString();
                })();

            const uploadSession = getUploadSession(uploadKey);
            const response = await fetchWithTimeout(requestUrl, {
                method: "PUT",
                signal: uploadSession.controller.signal,
                headers: directS3
                    ? { "Content-Length": String(chunk.byteLength) }
                    : authHeaders(apiKey, {
                        "Content-Type": "application/octet-stream",
                        "Content-Length": String(chunk.byteLength)
                    }),
                duplex: "half",
                body: progressBody(chunk, loaded => {
                    const transferredBytes = Math.min(totalBytes, completedBytes + loaded);
                    setProgress(uploadKey, {
                        phase: "uploading",
                        percent: Math.min(99, Math.round(transferredBytes / totalBytes * 100)),
                        transferredBytes,
                        totalBytes,
                        partNumber,
                        totalParts,
                        status: `Uploading part ${partNumber}/${totalParts} via Mocha...`
                    });
                })
            } as RequestInit & { duplex: "half"; });

            getUploadSession(uploadKey);

            if (!response.ok) {
                throw new Error(`Part ${partNumber} failed: ${response.status} ${await response.text()}`);
            }

            const etag = directS3
                ? response.headers.get("ETag")
                : (await response.json()).etag ?? response.headers.get("ETag");

            if (!etag) {
                throw new Error(`No ETag returned for part ${partNumber}`);
            }

            return etag;
        } catch (error) {
            if (attempt === PART_RETRIES) {
                throw error;
            }

            await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        }
    }

    throw new Error(`Part ${partNumber} failed`);
}

async function abortMultipart(apiKey: string, session: any, totalParts: number) {
    await fetchWithTimeout(`${MOCHA_BASE}/api/files/multipart/abort`, {
        method: "POST",
        headers: authHeaders(apiKey, {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            ...session,
            partNumbers: Array.from({ length: totalParts }, (_, index) => index + 1)
        })
    }, 15 * 1000).catch(() => undefined);
}

async function uploadMultipart(
    uploadKey: string,
    apiKey: string,
    fileBuffer: ArrayBuffer,
    filename: string,
    mimeType: string,
    destinationFolder: string
): Promise<string> {
    const remotePath = `${destinationFolder}/`;
    const size = fileBuffer.byteLength;
    const initResponse = await fetchWithTimeout(`${MOCHA_BASE}/api/files/multipart/init`, {
        method: "POST",
        headers: authHeaders(apiKey, {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            originalName: filename,
            path: remotePath,
            size,
            mimeType,
            partSizeBytes: CHUNK_SIZE
        })
    }, 30 * 1000);

    if (!initResponse.ok) {
        throw new Error(`Multipart init failed: ${initResponse.status} ${await initResponse.text()}`);
    }

    const initData = await initResponse.json();
    const session = {
        strategy: initData.strategy,
        uploadId: initData.uploadId,
        key: initData.key,
        nodeId: initData.nodeId,
        originalName: filename,
        path: remotePath,
        directUploadEnabled: initData.directUploadEnabled
    };

    if (!session.strategy || !session.uploadId || !session.key || !session.nodeId) {
        throw new Error(`Invalid multipart init response: ${JSON.stringify(initData)}`);
    }

    const totalParts = Math.ceil(size / CHUNK_SIZE);
    const parts: Array<{ partNumber: number; etag: string; }> = [];
    let completedBytes = 0;

    try {
        for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
            getUploadSession(uploadKey);

            const offset = (partNumber - 1) * CHUNK_SIZE;
            const chunk = fileBuffer.slice(offset, Math.min(size, offset + CHUNK_SIZE));
            const etag = await uploadPart(uploadKey, apiKey, session, chunk, partNumber, totalParts, completedBytes, size);

            completedBytes += chunk.byteLength;
            parts.push({ partNumber, etag });
            setProgress(uploadKey, {
                phase: "uploading",
                percent: Math.min(99, Math.round(completedBytes / size * 100)),
                transferredBytes: completedBytes,
                totalBytes: size,
                partNumber,
                totalParts,
                status: `Uploaded part ${partNumber}/${totalParts}.`
            });
        }
    } catch (error) {
        await abortMultipart(apiKey, session, totalParts);
        throw error;
    }

    setProgress(uploadKey, {
        phase: "uploading",
        percent: 99,
        transferredBytes: size,
        totalBytes: size,
        partNumber: totalParts,
        totalParts,
        status: "Finalizing multipart upload..."
    });

    const completeResponse = await fetchWithTimeout(`${MOCHA_BASE}/api/files/multipart/complete`, {
        method: "POST",
        headers: authHeaders(apiKey, {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            ...session,
            size,
            mimeType,
            parts: parts.sort((a, b) => a.partNumber - b.partNumber)
        })
    }, 60 * 1000);

    if (!completeResponse.ok) {
        throw new Error(`Multipart complete failed: ${completeResponse.status} ${await completeResponse.text()}`);
    }

    return getFileId(await completeResponse.json());
}

async function createShare(apiKey: string, fileId: string, shareExpiry: string): Promise<string> {
    const payload: Record<string, unknown> = { fileId };
    const hours = expiryHours(shareExpiry);

    if (hours !== null) {
        payload.expiresInHours = hours;
    }

    const response = await fetch(`${MOCHA_BASE}/api/shares`, {
        method: "POST",
        headers: authHeaders(apiKey, {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`Share create failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const token = data?.token ?? data?.share?.token;

    if (!token) {
        throw new Error("No share token returned from Mocha");
    }

    return `${MOCHA_BASE}/share/${token}`;
}

export async function uploadToMocha(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    mimeType: string,
    apiKey: string,
    shareExpiry: string,
    uploadKey: string
): Promise<NativeUploadResult> {
    activeUploads.set(uploadKey, {
        cancelled: false,
        controller: new AbortController(),
        progress: {
            phase: "preparing",
            percent: 1,
            transferredBytes: 0,
            totalBytes: fileBuffer.byteLength,
            partNumber: 0,
            totalParts: 0,
            status: "Preparing upload..."
        }
    });

    try {
        const destinationFolder = `/discord/${today()}`;

        await ensureFolder(apiKey, destinationFolder);

        const fileId = fileBuffer.byteLength <= DIRECT_UPLOAD_LIMIT
            ? await uploadDirect(uploadKey, apiKey, fileBuffer, filename, mimeType || "application/octet-stream", destinationFolder)
            : await uploadMultipart(uploadKey, apiKey, fileBuffer, filename, mimeType || "application/octet-stream", destinationFolder);

        setProgress(uploadKey, {
            phase: "sharing",
            percent: 99,
            transferredBytes: fileBuffer.byteLength,
            totalBytes: fileBuffer.byteLength,
            status: "Creating Mocha share link..."
        });

        return {
            success: true,
            url: await createShare(apiKey, fileId, shareExpiry)
        };
    } catch (error) {
        setProgress(uploadKey, {
            phase: activeUploads.get(uploadKey)?.cancelled ? "cancelled" : "failed",
            status: error instanceof Error ? error.message : "Unknown error"
        });

        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error"
        };
    } finally {
        setTimeout(() => activeUploads.delete(uploadKey), 10 * 1000);
    }
}

export async function getUploadProgress(_: IpcMainInvokeEvent, uploadKey: string): Promise<NativeUploadProgress | null> {
    return activeUploads.get(uploadKey)?.progress ?? null;
}

export async function cancelUpload(_: IpcMainInvokeEvent, uploadKey: string): Promise<void> {
    const session = activeUploads.get(uploadKey);
    if (!session) return;

    session.cancelled = true;
    session.controller.abort();
    setProgress(uploadKey, {
        phase: "cancelled",
        status: "Upload cancelled."
    });
}
