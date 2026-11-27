<p align="center">
  <img
    width="800"
    height="520"
    alt="Splitwriter Logo"
    src="./assets/icons/Splitwriter_Logo_Page.png"
  />
</p>

<h1 align="center">Splitwriter</h1>
<p align="center"><em>For all creators — past, present, and future.</em></p>

Splitwriter is a free, offline writing workspace for novels, scripts, journals, and other creative projects. It brings writing and reference materials together in a flexible, distraction-light layout.

## Download — Splitwriter 2.0 Plain

**Current release:** v2.0.0 · Portable · Windows x64

[**Download Splitwriter for Windows x64**](https://github.com/crom-foo/Splitwriter/releases/latest)

- **UI language:** English
- **Typing input:** System IME/keyboard support, with language options including 한국어, 日本語, 中文, Русский, and others
- **Price:** Free for personal and commercial creative work

## Quick Start

1. Download and extract Splitwriter, then run `Splitwriter.exe`. No installation is required.
2. Open **… → About** to review the shortcuts and available actions.
3. Open **Preferences** to choose typefaces and writing behavior. Use **Presets** at the top of the Preferences window to save your settings for later.
4. Write as much as you like.
5. For important work, save often with **Ctrl+S** or the Save button. Splitwriter keeps up to 10 changed-project backups in the `_Backups` folder beside your project file.

## The Workspace

Splitwriter was made to help writers spend more time with their stories—not with the tools around them. Write in a TextBoard, keep reference materials close, and arrange your workspace to suit your process.

<img
  width="1100"
  alt="Splitwriter 2.0 Workspace"
  src="./assets/splitwriter-main-2.0.png"
/>

## What's Included in 2.0

- **Navigator** — Organize boards in Writing and Notes groups. Move boards and groups, and open boards by dragging them into the workspace.
- **Drafts** — Explore different board orders for a manuscript without changing your main Writing arrangement.
- **Manuscript View** — Read the combined text from your Writing boards in order, set spacing between boards, and export as text or PDF.
- **Anchor Board & Anchor Pane** — Keep a designated main working board close at hand.
- **TextBoard** — Write with typeface presets, Typewriter mode, paragraph indentation, writing goals, and Undo/Redo.
- **ImageBoard** — View reference images alongside your writing. Images are referenced by file path rather than embedded in the `.swon` project.
- **Echo View** — Read your writing in an immersive presentation.
- **Flexible workspace** — Split, move, and duplicate boards with their handles.
- **Rolling backups** — Manual saves (Ctrl+S or the Save button) keep up to 10 changed-project snapshots in a `_Backups` folder. Autosave works separately.

## Manual

The Splitwriter 2.0 manual is available in Korean and English:

- [English manual (PDF)](docs/manual/Splitwriter-Manual-v2.0-English.pdf)
- [한국어 매뉴얼 (PDF)](docs/manual/Splitwriter-Manual-v2.0-Korean.pdf)

## Requirements & Getting Started

- **Platform:** Windows x64
- **Recommended OS:** Windows 10 (1803) or later
- **Runtime:** [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)

For the portable build:

1. Download the ZIP from [Releases](https://github.com/crom-foo/Splitwriter/releases/latest).
2. Extract it to a folder of your choice.
3. Run `Splitwriter.exe`.

If the app does not start, check that the WebView2 Runtime is installed. This release is unsigned, so Windows SmartScreen may show a warning.

## Raspberry Pi Test Build

A Raspberry Pi test build is available for **64-bit ARM Linux** (`aarch64`). It is an early test build and is not yet covered by the Windows release support policy. Use a 64-bit Raspberry Pi OS image based on Bullseye or Ubuntu 22.04, with a desktop session and internet access for the initial build. The app uses the system WebKitGTK runtime.

From the project directory on the Pi, install the native build dependencies and run the build script:

```sh
sudo apt update
sudo apt install -y build-essential curl file wget patchelf libssl-dev librsvg2-dev \
  libayatana-appindicator3-dev libwebkit2gtk-4.0-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
bash ./build-raspberry-pi.sh
```

The Debian package is written to `src-tauri/target/aarch64-unknown-linux-gnu/release/bundle/deb/`. Install it with `sudo apt install ./<package-name>.deb`. Share that package only with Raspberry Pi OS 64-bit testers; it will not run on 32-bit Pi OS or Windows. This build currently needs to be compiled on the Pi (or an equivalent ARM64 Linux machine).

## Project Files & Privacy

Splitwriter uses the `.swon` project format, based on JSON. Writing and project layout are stored locally. Image boards refer to image files by path, so those files may need relinking if moved.

Splitwriter is designed for offline writing without an account or mandatory cloud service.

## License

Splitwriter is released under the **MIT License** and is intended to remain free for personal and commercial creative work.

Created by **Crom Kim & GPT**, 2025–2026.

## Support

Support is optional. Thank you for using Splitwriter.

If it helped you, you can buy me a coffee ☕  
PayPal: [paypal.me/splitwriter](https://paypal.me/splitwriter)
