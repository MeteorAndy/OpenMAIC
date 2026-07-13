# OpenMAIC Desktop

<p align="center">
  <img src="assets/banner.png" alt="OpenMAIC Desktop" width="680"/>
</p>

<p align="center">
  A desktop edition of <a href="https://github.com/THU-MAIC/OpenMAIC">OpenMAIC</a> — the open-source multi-agent interactive classroom — packaged as a local desktop app.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="License: MIT"/></a>
  <img src="https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js" alt="Next.js"/>
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React"/>
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Tauri-desktop-orange?style=flat-square&logo=tauri&logoColor=white" alt="Tauri"/>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README-zh.md">简体中文</a>
</p>

## Overview

**OpenMAIC Desktop** is a desktop build of [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) (Open Multi-Agent Interactive Classroom). It keeps the full multi-agent classroom experience — AI teachers and classmates that generate slides, quizzes, interactive simulations, and project-based learning activities, with voice narration and whiteboard drawing — and runs it locally on your machine as a native desktop application, no server deployment required.

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **pnpm** >= 10
- Rust toolchain (for the Tauri desktop build)

### Install & Run

```bash
pnpm install
cp .env.example .env.local   # fill in at least one LLM provider key
pnpm tauri dev
```

For web-only development (no desktop shell):

```bash
pnpm dev
```

### Configuration

OpenMAIC Desktop supports the same LLM, TTS, ASR, and image providers as upstream OpenMAIC. Configure them in `.env.local` or via the in-app Settings panel. See [`.env.example`](.env.example) for the full list.

## Features

- **One-click lesson generation** — describe a topic or attach materials; the AI builds a full lesson in minutes
- **Multi-agent classroom** — AI teachers and peers lecture, discuss, and interact in real time
- **Rich scene types** — slides, quizzes, interactive HTML simulations, project-based learning (PBL)
- **Whiteboard & TTS** — agents draw diagrams, write formulas, and explain out loud
- **Deep interactive mode** — 3D visualization, simulations, games, mind maps, in-browser programming
- **Export** — editable `.pptx` slides, interactive `.html`, classroom `.zip`
- **Local-first** — runs as a native desktop app; your data stays on your machine

## Attribution

This project is **based on [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)** by THU-MAIC, distributed under the [MIT License](LICENSE). All upstream work and the original classroom platform are credited to the OpenMAIC authors.

## Contributing

Issues and pull requests are welcome. Fork the repo, create a feature branch, and open a PR.

## License

Licensed under the [MIT License](LICENSE).

### Third-Party Components

The repository bundles workspace packages that are **not** covered by the root MIT license and keep their own terms:

- `packages/mathml2omml` — [LGPL-3.0-or-later](packages/mathml2omml/LICENSE)
- `packages/pptxgenjs` — [MIT](packages/pptxgenjs/package.json) (third-party)

When redistributing the repository as a whole, the terms of each bundled package above apply to that package's files.
