# Third-Party Notices

## PuTTY

FluorCast can package the official PuTTY 64-bit Windows standalone tools for the
Native Windows SSH NIBI transport.

- Version: 0.84
- Upstream source: https://www.chiark.greenend.org.uk/~sgtatham/putty/releases/0.84.html
- Checksum source: https://the.earth.li/~sgtatham/putty/0.84/sha256sums
- License: MIT

Pinned SHA-256 hashes for the standalone 64-bit executables:

- `putty.exe`: `7056ca2f6a9f3c525845b116c7bf564ced3284a4083ea80d7e9ef51a16f612c4`
- `plink.exe`: `e5621ffe4879f0ec39ed40f688db9399c2d43054d41ef14472fa335c4693b915`
- `pscp.exe`: `fb2d69f840026a562629d757095c968b5748daaf1d08fad14414a8ef79de319e`

Run `scripts\prepare-putty-resources.ps1` before release packaging. The script
downloads only from the official PuTTY release host, verifies these hashes, and
copies the tools into `src-tauri\resources\putty`.

The PuTTY MIT license text is available from the upstream project:
https://www.chiark.greenend.org.uk/~sgtatham/putty/licence.html
