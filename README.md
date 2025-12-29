<p align="center">
  <img
    width="300"
    height="400"
    alt="Logo_Light_Splitwriter"
    src="https://github.com/user-attachments/assets/14371b15-b59f-4eb3-91de-7d391a5de180"
  />
</p>

# Splitwriter

_For all creators — past, present, and future._

Splitwriter is a focused writing tool built to make creative work easier.  
Instead of fighting with a heavy word processor, you just open Splitwriter and start writing.

Current beta: **v0.9.9-beta.5** — **Portable (Windows x64)**

UI language: **English**

Typing input (IME/keyboard): Auto (System) + manual options (e.g. English, 한국어, 日本語, 中文, Русский, …)

Free Forever — Splitwriter aims to stay free for both personal and commercial creative work.

_Made by a stubborn nagger who refuses to quit, with 100% coding support from ChatGPT._  
_created by Crom Kim & GPT, 2025_

---

## Why Splitwriter?

This program exists for one purpose: **to support comfortable, uninterrupted writing.**

- No account, no network, no cloud lock-in.
- Simple but powerful split layout for text, references, and management.
- Just enough features for long-form creative work, without turning into a full office suite.

If you want a small notebook-like tool for novels, scripts, or journals, Splitwriter is for you.

<img width="1100" height="720" alt="screenshot" src="https://github.com/user-attachments/assets/2b7765b3-26b1-46b4-a8c1-fb504d73a66e" />

---

## Key Features

### Core Design

- **Complete Security**  
  Splitwriter works fully offline. It does not collect user information or require an internet connection.

- **Factory Initialization**  
  You can reset presets and settings by deleting the configuration files — a “factory reset” is always possible.

- **Free Forever**  
  Licensed under MIT and intended to remain free for personal and commercial creative work.

### Boards

- **Text Board**  
  Preset-based text editor for comfortable writing. Switch between headline/body/accent/emphasis presets for different parts of your manuscript.

- **Echo View (Cinematic Preview)**
  Instantly preview the selected text in a clean, full-screen, visual-novel-style layout.
  Echo View can display your text alone against a dark background, or combine it with the current reference image to create a scene-like presentation.
  Perfect for reviewing dialogue, checking flow, practicing readings, or preparing YouTube/lecture scripts.

- **Image Board**  
  An image viewer for description and reference. Images are **referenced by path only** and are not embedded into the `.swon` file.

- **Viewer Board**  
  Open another `.swon` file side-by-side in a read-only view to reference older drafts or notes.

- **Manage Board**  
  Organize your `.swon` projects and user data in one place.

### Layout & Interaction

- **Flexible Layout**  
  Free horizontal/vertical splitting of panes with minimum-size guards.  
  Double-click a split handle to snap panes to a clean 50 / 50 layout.

- **Typewriter Mode**  
  Keeps the current line at a comfortable height while you type, so your eyes don’t have to chase the cursor.

- **Accent Color**  
  A single accent color that instantly changes the overall mood of the editor.

### Writing Utilities

- **Auto Save**  
  Timer-based autosave using seconds. Your work is automatically saved at regular intervals.

- **Curly Braces Replacement**  
  For writers who rarely use `{ }`, Splitwriter can replace them with more writing-friendly symbols.

- **Writing Goal HUD**  
  A small heads-up display that shows your current progress toward a writing goal.

- **Undo / Redo**  
  Per-board history for both text and image edits (up to 20 steps, including selection restore).

---

## System Requirements

- **OS**: Windows 10 (1803) or later recommended  
- **Runtime**: Requires **Microsoft WebView2 Runtime**

If the app does not start, please install the WebView2 runtime first.

---

## How to Run (Portable)

1. Download the latest portable ZIP from the **Releases** page.
2. Extract the ZIP to any folder.
3. Double-click **`Splitwriter.exe`** to launch the app.

No installation is required.

---

## If the App Does Not Start

Try running the bundled WebView2 installers in this order:

1. `runtime/MicrosoftEdgeWebview2Setup.exe`  
   - **Recommended** (online installer, requires internet connection)
2. `runtime/MicrosoftEdgeWebView2RuntimeInstallerX64.exe`  
   - **Offline option** if the first one fails

After installation, launch `Splitwriter.exe` again.

---

## Data & File Format

- Project data is saved under your **local app data folder**  
  (a sub-folder of `AppData\Local` in your user profile).
- Splitwriter uses its own file format: **`.swon`**  
- Existing `.swon` files can be opened from **`File → Open`**.

---

## Security Warning (SmartScreen)

This beta build is **not digitally signed**, so Windows SmartScreen may show a warning.

1. Click **“More info”**
2. Click **“Run anyway”** to start Splitwriter

This is expected behavior for unsigned beta builds.

---

## License

Splitwriter is released under the **MIT License**.

Free forever for personal and commercial creative work.  
Made by Crom Kim & GPT, 2025.
