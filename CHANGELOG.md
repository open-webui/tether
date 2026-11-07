# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] - 2026-11-07

### Changed

- **New app icon.** Replaced the solid Open WebUI mark with a dotted version on a light dot-grid background. Updated the app icons for Mac, Windows, and Linux.

### Fixed

- **Mac menu-bar icon.** Tether now uses a simple monochrome symbol that adapts to light and dark menu bars, instead of shrinking the full app icon. Included a sharper version for Retina displays.
- **Connection name label.** Added a small gap between **Name** and **optional** when adding or editing a connection, so the two labels no longer run together.

## [0.1.4] - 2026-11-06

### Fixed

- **Broken WebUI addresses.** Adding or editing a connection now checks that the address is reachable and serves Open WebUI before saving it. Unreachable servers, broken redirects, and addresses pointing to another kind of website show an error. If a new address fails the check, your existing connection and sign-in are kept. Working local HTTP addresses are still supported.
- **Unexpected browser windows when opening a connection.** If a WebUI address redirects elsewhere, such as from `http://` to `https://`, Tether now asks you to edit the connection to use the final address instead of unexpectedly opening your browser.
- **Appearance resetting after restart.** Tether now keeps your saved light, dark, or automatic appearance when a connection opens. An older WebUI's previous appearance can no longer overwrite that choice during startup.
- **Installed agents not found when opening Tether from Finder.** Open Terminal now also looks in common installation folders for agent tools such as Codex, Claude Code, Cursor, and OpenCode, plus Homebrew-installed tools on Mac. This fixes cases where an installed agent or a program it needs could be found from a terminal but not from Tether. Agent chats require compatible Open Terminal and WebUI versions, with the agent installed and signed in on your computer.

## [0.1.3] - 2026-11-06

### Fixed

- **Sign-in on older WebUI versions.** Clicking a sign-in provider or opening a WebUI that signs in automatically no longer stops just because the server lacks Tether's browser sign-in support. Tether continues sign-in inside the app and keeps the same login session through redirects and pop-up windows. Servers that support browser sign-in still open your default browser. Some providers, including Google, may still refuse sign-in inside desktop apps.
- **Location lookups that stall message sending.** When location sharing is enabled in WebUI, Tether now stops waiting for a location after at most 10 seconds, including time spent waiting for permission. WebUI can then continue sending without a location. This timeout applies on Mac, Windows, and Linux; getting a location still depends on your system's location services.
- **Mac permission prompts.** Added the description macOS needs when Tether requests your location. Corrected how the app includes its camera, microphone, Documents, and Downloads permission descriptions so macOS can read them too.
- **Access from sign-in pages and embedded content.** Location access is now limited to the saved WebUI page. Sign-in popups, embedded pages, and pages outside the saved WebUI address cannot use that permission. Tether's app controls are also kept off external sign-in pages.

## [0.1.2] - 2026-11-05

### Changed

- **Fewer pauses during remote transfers.** Tether can now send more data before waiting for a reply from WebUI, helping large file transfers, terminal output, and browser images move faster on connections with noticeable delay. This requires a WebUI version that supports the change. Older WebUI versions keep the previous behavior and still connect normally.
- **Terminal input gets a turn during busy transfers.** File transfers, terminal traffic, and browser updates now take turns sending small pieces of data over the shared connection, so one large transfer does not send everything ahead of the others.
- **Downloads in the README.** Added direct download links for Mac, Windows, and Linux, plus a link to Snap and Flatpak packages. The README also links to the new manifesto explaining how Tether lets you reach your own computer from another device, and directs bug reports and ideas to GitHub issues.

### Fixed

- **Memory use when a remote connection falls behind.** Limited how much terminal and browser output Tether keeps waiting to send. If too much builds up, Tether closes the affected connection instead of continuing to collect output in memory.

## [0.1.1] - 2026-11-05

### Added

- **Chrome connection choice.** In **Settings → Open Terminal**, choose **Launch Chrome** for a separate browser profile or **Connect to running Chrome** to use your existing website logins. Connecting to running Chrome requires Open Terminal 0.16.3 or later. Enable remote debugging in Chrome and approve the connection when Chrome asks. Leave **Connection URL** blank to find Chrome automatically, or enter the address of the Chrome instance you want to use. Click **Restart to apply** after changing these settings.
- **Browser and desktop switches.** Turn WebUI's browser tools and Open Terminal's desktop viewing and control on or off separately under **Tools**. Desktop access requires a supported system. Click **Restart to apply** to apply either change.
- **File browsing starting folder.** Choose **Home directory**, **File system**, or **Custom folder** under **File browser starts at**. Use **Browse** to pick a custom folder. This changes where file browsing begins; it does not restrict which files or folders commands can access.
- **Terminal session limit.** Set the maximum number of terminal sessions Open Terminal can keep open at once. The field stays blank unless you set a limit, and clearing it restores Open Terminal's default.

### Changed

- **Open Terminal settings layout.** Common options now appear under **Tools** and **Files**, with the environment-variable editor tucked into a collapsed **Advanced** section. Changes in the regular controls and Advanced stay in sync both ways. **Restart to apply** remains visible when Advanced is closed.

### Fixed

- **Settings arrows and labels.** Aligned the Back arrow with its label and gave the browser and file-folder dropdown arrows their own space so they do not overlap the selected text.
- **Mac downloads.** Corrected Mac packaging so Intel and Apple silicon downloads are built separately.

## [0.1.0] - 2026-11-05

### Added

- **Spotlight for quick questions.** Press **Cmd+Shift+I** on macOS or **Ctrl+Shift+I** on Windows and Linux to open a small prompt window over your current app. Start typing immediately, choose one of your saved WebUI connections, and press Enter to send into a new chat. Tether opens that WebUI so you can continue the conversation. Change or disable the shortcut in Settings, or open Spotlight from the tray menu.
- **Screenshots and pasted images.** Drag across part of your screen in Spotlight to attach a screenshot, or paste an image from your clipboard. Preview and remove attachments before sending, with up to four images per prompt. On Linux with a screen picker, choose a screen first, then select the area to capture. Open Terminal is not required.
- **Clipboard text and saved Spotlight drafts.** Enable **Paste clipboard into Spotlight** in General settings to fill an empty prompt with copied text. Closing Spotlight keeps your unsent text, images, and chosen connection while Tether stays running. Failed or unconfirmed sends keep the draft too. Drag the prompt window to move it; Tether remembers its position.
- **Background notifications.** Get alerts when a chat finishes or fails, a calendar reminder is due, or a channel message arrives, even when the relevant saved connection is not open. Clicking an alert brings up its chat, channel, or calendar in the correct connection. Notifications work without Open Terminal installed and continue after you uninstall it. Keep Tether running and enable notifications in WebUI to receive them.
- **Screen sharing in WebUI calls.** Use WebUI's existing Screen Share control from inside Tether. The call panel shows a live preview and can attach a screenshot of your screen with each spoken turn.
- **Right-click menus.** Cut, copy, paste, undo, redo, and choose spelling corrections in text fields. Right-click a link to copy it or open it in your browser, or right-click an image to copy or save it.
- **Language selection.** Choose English, Arabic, Bulgarian, Dutch, French, German, Hebrew, Hindi, Italian, Japanese, Korean, Polish, Russian, Spanish, Simplified Chinese, or Traditional Chinese in General settings. Connection screens, Settings, Spotlight, and terminal controls use the selected language, with right-to-left layouts for Arabic and Hebrew.
- **Automatic-update control.** Turn **Automatic desktop updates** on or off in About to choose whether Tether downloads app updates automatically. You can still check for updates and download them manually when it is off. Open Terminal's update setting remains separate.

### Changed

- **Matching appearance in Tether and WebUI.** Changing Tether's light, dark, or automatic appearance also updates open, compatible WebUI connections. Changing the appearance in WebUI updates Tether's surrounding window, and switching connections follows that connection's appearance.
- **Remembered window size and position.** Tether reopens at its previous size and location, including whether it was maximized. If the monitor you used is disconnected, the window opens on an available display.

### Fixed

- **Browser startup through Tether.** Fixed a startup timing issue that could leave WebUI's browser panel blank or show an error when opening a browser on this computer.
- **Recovery after app crashes.** Tether reloads its main window if the app interface crashes. After a graphics crash, it tries one restart with fallback graphics settings and remembers those settings for later launches.

## [0.0.1] - 2026-11-05

### Added

- **Multiple Open WebUI connections.** Save your work and personal WebUI addresses and switch between them from the bottom bar. Each connection keeps its page open, so switching does not reload your chats or clear unfinished messages.
- **Separate accounts.** Sign into different accounts on the same WebUI address. Each saved connection keeps its own sign-in and browsing data.
- **Persistent sign-in.** Stay signed in across app restarts on compatible WebUI versions. Tether renews your sign-in automatically and retries interrupted renewals, including after restarting the app. Browser-based sign-in opens in your default browser and returns you to Tether.
- **Connection editing.** Rename a saved connection without interrupting its open page. Change its address to connect somewhere else, or remove it and sign out. Changing an address clears the previous sign-in.
- **Page controls.** Refresh the current WebUI or open it in your default browser. The title bar follows the page or chat you are viewing.
- **Optional local files and commands.** Install Open Terminal to let your connected WebUI accounts work on this computer. The first connection offers an install prompt with a **Not now** option. You can use WebUI without installing it and set it up later in Settings.
- **Access from another browser.** While Tether is running, sign into the same account on a compatible WebUI from another browser to use this computer's files and commands. You do not need to open incoming connections to your computer or configure your router. All signed-in, compatible WebUI connections remain connected when you switch tabs.
- **Computer names in WebUI.** Your terminal and new sign-in sessions use your computer's name. Set a custom device name in Settings, or leave it blank to use the name shown in the field.
- **Connection status.** The terminal indicator shows whether the selected WebUI is connected to this computer. It distinguishes **Connected to WebUI** from **Running locally · Not connected to WebUI**. Tether reconnects automatically when the connection drops and retries when WebUI does not yet support Tether.
- **Open Terminal setup and updates.** Install or update Open Terminal from Settings without installing Python yourself. Choose a specific Open Terminal version or use the latest, with optional updates at startup. Uninstalling stops local access and keeps your files and saved WebUI connections.
- **Starting folder.** Choose the folder Open Terminal uses for files and commands with a folder picker. Leaving it blank uses your user folder and shows that folder's path as a placeholder. Use **Restart to apply** after changing it.
- **Built-in terminal panel.** Open the bottom panel to read and copy Open Terminal output or run commands yourself in the **Shell** tab. Resize or collapse the panel without stopping the shell.
- **Background operation.** Keep Tether running when you close its window, start it minimized, and enable launch at login on macOS and Windows. Bring it forward from any app with **Cmd+Shift+T** on macOS or **Ctrl+Shift+T** on Windows and Linux. The shortcut can be changed or disabled.
- **Appearance and settings.** Choose light, dark, or system appearance and search Settings by name. The connection screen has slowly rotating chain artwork that pauses when the window is hidden and respects reduced-motion preferences.
- **App updates and release notes.** Check for Tether updates, see download progress, and restart to install from About. Click the version in the bottom bar to open About, then **Read changelog** to view release notes inside the app.
- **Factory reset.** Clear Tether's settings, saved connections, local sign-ins, and installed components after confirmation. Your hosted WebUI data and personal files are kept.
