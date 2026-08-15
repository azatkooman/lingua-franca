---
description: How to build the Lingua Franca Windows application with working SFU
---

### ⚠️ Critical Note for Parallels/VM Users
If you are using Parallels, **DO NOT** build in a "Shared Folder" (e.g., `\\Mac\Home\Documents`).
1. Copy the project folder to a **local directory** on the VM (e.g., `C:\murmur-translate`).
2. Delete any existing `node_modules` and `package-lock.json` before installing.

### Prerequisites on Windows
1. **Node.js**: Install Node.js 20 or later.
2. **Build Tools**: `mediasoup` requires Python and a C++ compiler.
   - Run this in an Administrator PowerShell:
     ```powershell
     npm install --global windows-build-tools
     ```
   - Alternatively, install [Visual Studio Community](https://visualstudio.microsoft.com/vs/community/) with the "Desktop development with C++" workload.

### Build Steps
1. Open a terminal (PowerShell or CMD) in the project directory.
2. **Clean existing install**:
   ```powershell
   rm -Recurse -Force node_modules
   rm package-lock.json
   ```
3. **Install dependencies**:
   ```powershell
   npm install
   ```
   *This step will compile the `mediasoup-worker.exe` for Windows ARM.*
4. **Build the application**:
   ```powershell
   npm run electron:build
   ```

### Troubleshooting
If you see `mediasoup-worker.exe ENOENT`, it usually means the binary wasn't built or was excluded.
- Ensure `node_modules/mediasoup/worker/out/Release/mediasoup-worker.exe` exists after `npm install`.
- Check that `package.json` has `mediasoup` in `asarUnpack`.
