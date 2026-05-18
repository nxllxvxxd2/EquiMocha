```
███████  ██████  ██    ██ ██ ███    ███  ██████   ██████ ██   ██  █████  
██      ██    ██ ██    ██ ██ ████  ████ ██    ██ ██      ██   ██ ██   ██ 
█████   ██    ██ ██    ██ ██ ██ ████ ██ ██    ██ ██      ███████ ███████ 
██      ██ ▄▄ ██ ██    ██ ██ ██  ██  ██ ██    ██ ██      ██   ██ ██   ██ 
███████  ██████   ██████  ██ ██      ██  ██████   ██████ ██   ██ ██   ██
```
# INSTRUCTIONS (PLEASE READ)
Requirements:
- [NodeJS 18 or higher](https://nodejs.org/en/download)
- [Git](https://git-scm.com/downloads)

Okay this is a different type of install.
1. Clone the Equicord repo `git clone https://github.com/Equicord/Equicord`
	You **HAVE TO CLONE THIS REPO**, it cannot build without the .git
2. In a seperate folder clone EquiMocha `git clone https://github.com/nxllxvxxd2/EquiMocha` 
	You can also download the zip and extract it, but I recommend using git for easier updates
3. Move the contents of the EquiMocha folder (just cut/copy and paste the folder itself) into ./Equicord/src/plugins
4. Be sure you have pnpm installed, if not install with `npm i -g pnpm`
5. Navigate to the top of your Equicord folder
6. Run `pnpm install --frozen-lockfile`
7. Run `pnpm build`
8. Run `pnpm inject`
9. Follow the installation prompts
10. Restart Discord and the plugin should be under your plugins list in the settings menu


## The Basics
- Autotriggers on files, either selected or dropped in that are larger than 9MB
- Uploads to a folder, the stock being /Discord, then seperated in folders by date
- Shows progress of upload in the Discord client
- Auto sends the link once upload is complete
- If files land under the standard max for Discord without Nitro it will just upload through Discord



