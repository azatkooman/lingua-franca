---
description: How to build the Lingua Franca Windows application with working SFU
---

### Critical rule
Build from a local Windows directory. Never copy `node_modules` or `release` from macOS.

### Prerequisites on Windows
1. **Node.js**: Install the current Node.js LTS x64 release.
2. **Build Tools**: `mediasoup` requires Python and a C++ compiler.
   - Install Visual Studio Build Tools with the "Desktop development with C++" workload.

### Build Steps
1. Open a terminal (PowerShell or CMD) in the project directory.
2. Remove only an install copied from another operating system:
   ```powershell
   rm -Recurse -Force node_modules
   ```
3. **Install dependencies**:
   ```powershell
   npm ci
   ```
   This installs the native x64 `mediasoup-worker.exe`.
4. **Build the application**:
   ```powershell
   npm run electron:build:win
   ```

### Troubleshooting
If you see `mediasoup-worker.exe ENOENT`, it usually means the binary wasn't built or was excluded.
- Ensure `node_modules/mediasoup/worker/out/Release/mediasoup-worker.exe` exists after `npm ci`.
- Check that `package.json` has `mediasoup` in `asarUnpack`.
