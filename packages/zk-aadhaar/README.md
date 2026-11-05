# Aadhaar QR Verifier (zkAadhaar)

A single-page Next.js app that scans an **Aadhaar Secure QR code** with the device camera (or from an
image), decodes it, **verifies UIDAI's RSA-2048 digital signature offline**, and shows the demographic
details and photo. Everything runs in the browser: there is no backend, and the page's
Content-Security-Policy blocks requests to any other origin.

- Next.js 16 (App Router, static export) · React 19 · Tailwind CSS 4
- QR decoding: [`zxing-wasm`](https://github.com/Sec-ant/zxing-wasm) (ZXing C++ → WebAssembly) in a Web
  Worker, with [`@zxing/library`](https://github.com/zxing-js/library) as a fallback when WebAssembly is unavailable
- Decompression: [`pako`](https://github.com/nodeca/pako) · Signatures: Web Crypto (`crypto.subtle`)
- Photo: JPEG 2000 decoded with [`jpeg2000`](https://github.com/runk/jpeg2000) (pure JS) and shown as a JPEG data URL

## How a Secure QR is read

```
QR symbol ──► decimal digits (QR numeric mode, ~3,200 digits, version ~30)
          ──► BigInt ──► big-endian bytes ──► GZIP inflate (pako)
          ──► [ text fields separated by 0xFF | photo (JPEG 2000) | extra ] [ 256-byte signature ]
                └──────────── signed data ───────────────────────────┘
          ──► RSASSA-PKCS1-v1_5 / SHA-256 verify (Web Crypto) against pinned UIDAI certificates
```

Field layouts handled (`src/lib/aadhaar/parse.ts`):

| Layout | Fields before the photo | After the photo |
| --- | --- | --- |
| Legacy (2019, no marker) | email/mobile indicator, reference ID, name, DOB, gender, care of, district, landmark, house, location, PIN, post office, state, street, sub-district, VTC | 32-byte e-mail and/or mobile hashes (per indicator) |
| `V2`, `V3`, `V5` | version marker + the 16 fields above + mobile (`1234` or `XXXXXX1234`) | V5: masked e-mail (e.g. `axxxxx1@gxxxxx`) |

The reference ID is the **last 4 digits** of the Aadhaar number followed by the generation timestamp (IST).
A Secure QR never contains the full Aadhaar number.

### Where this differs from the original brief, and why

The brief described the payload slightly differently from how real Secure QR codes work. This was
checked against UIDAI's published layout, two independent open-source decoders (Anon Aadhaar, aadhaar-offline)
and a real e-Aadhaar QR (format `V5`, verified against UIDAI's 2026 key):

1. **The QR holds decimal digits, not binary.** UIDAI encodes the payload as one huge base-10 number in QR
   numeric mode. The decoder still captures the **raw payload bytes** (`ReadResult.bytes` from zxing-wasm, or
   byte segments from @zxing/library), and if a QR ever carried the GZIP stream directly in byte mode it is
   used as-is (`src/lib/aadhaar/payload.ts`).
2. **The signature is the last 256 bytes of the *decompressed* data**, not the first 256 bytes of the raw
   payload, and it signs all the decompressed bytes before it. Decompress first, then split.
3. **The photo is JPEG 2000**, which only Safari can display. It is decoded in JS and re-encoded as a base64
   JPEG data URL. In `V5`, a masked e-mail follows the photo directly, so the photo's length is read from its
   own codestream markers.
4. **zxing-wasm is the primary decoder.** On a version-30 test code, `@zxing/library` read 1 of 11 simulated
   camera frames (3 with multi-scale retries) and even missed a perfectly clean image at native resolution;
   zxing-wasm read every frame where the code was fully visible. `@zxing/library` is kept as the fallback.

## Trust model

Verification tries every trusted key, official UIDAI keys first, and reports which one matched. Keys are
never taken from the QR itself.

| Result | Meaning |
| --- | --- |
| 🟢 **Cryptographically Verified (Authentic)** | Valid signature under an official UIDAI certificate |
| 🟡 Valid signature — not from a UIDAI key | Signed by the built-in demo key or a key you imported without marking it official |
| 🔴 **Signature Verification Failed (Tampered / Invalid)** | No trusted key validates the data: it was altered or not signed by UIDAI |

Built-in certificates (`certs/uidai/`, embedded via `npm run certs:embed`), downloaded on 2026-11-04 from the
"Offline e-KYC public key certificates" section of <https://uidai.gov.in/en/data-and-download>, which
covers both Paperless Offline e-KYC and Secure QR codes. Expired keys are kept because a QR printed while a key
was current remains validly signed by it.

| File | Subject CN | Valid | SHA-256 fingerprint |
| --- | --- | --- | --- |
| `uidai_offline_publickey_2026.cer` | DS Unique Identification Authority of India 06 | 2026-02-03 → 2029-02-03 | `E0:30:4B:9E:61:EE:36:40:EC:DD:AE:2D:B4:B6:17:F2:E2:67:8F:57:DB:C2:82:6C:2F:86:AC:5C:04:F2:77:DF` |
| `uidai_offline_publickey_17022026.cer` | DS Unique Identification Authority of India 05 | 2024-02-21 → 2026-02-16 | `00:57:3C:69:2C:F0:4F:BE:E1:13:AE:5F:D5:2F:2A:65:4D:36:1B:F8:EE:4D:06:C4:60:08:90:6B:36:DF:81:69` |
| `uidai_offline_publickey_26022021.cer` | DS UNIQUE IDENTIFICATION AUTHORITY OF INDIA 05 | 2021-02-26 → 2024-02-27 | `E0:F0:F8:69:D3:2E:FC:7E:80:FA:E2:22:37:17:A5:6D:CF:8B:61:6F:82:0B:54:2A:49:E5:BD:5A:BF:1C:0F:7D` |
| `uidai_offline_publickey_29032019.cer` | DS UNIQUE IDENTIFICATION AUTHORITY OF INDIA 04 | 2019-03-15 → 2021-02-28 | `E0:F5:59:6D:2C:48:E1:9F:9C:C1:84:BC:CD:E7:12:9E:2D:89:87:F9:05:C7:3B:87:D1:85:1C:35:C6:22:D8:52` |
| `uidai_12_06_18_cer.cer` | DS UNIQUE IDENTIFICATION AUTHORITY OF INDIA 7 | 2018-06-08 → 2021-06-07 | `49:E2:98:53:22:43:CE:28:E2:63:3A:7E:4F:40:3D:9C:A7:8C:BF:DA:8B:3B:BD:E7:03:24:83:72:73:BA:4D:31` |
| `uidai_prod_cdup.cer` | DS UNIQUE IDENTIFICATION AUTHORITY OF INDIA 4 | 2017-06-08 → 2020-06-07 | `FC:F3:1A:3F:89:21:16:15:EB:D5:D4:49:AC:33:D8:D3:81:F6:54:D2:E2:D1:50:37:D5:CC:8D:4A:EB:72:F8:36` |
| `uidai_offline_publickey_26022019.cer` | DS UNIQUE IDENTIFICATION AUTHORITY OF INDIA 03 | 2017-04-27 → 2019-04-09 | `35:57:5C:63:C7:21:06:E8:03:51:10:04:F9:4B:FD:A5:49:52:B2:CF:21:84:C3:CE:1A:AD:61:F1:96:4C:58:D0` |

Re-check any of them with `openssl x509 -in certs/uidai/<file> -noout -fingerprint -sha256`.

**When UIDAI rotates its key:** either drop the new `.cer` into `certs/uidai/` and run `npm run certs:embed`,
or import it at runtime under **Trusted keys** (PEM text or `.cer/.crt/.pem/.der` file) and tick
"official UIDAI certificate" after checking its fingerprint. Imported public keys are kept in
`localStorage`. Nothing else is stored.

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000 (copies the decoder WASM into public/wasm first)
```

Camera access and Web Crypto need a **secure context**: `localhost` works, but a phone opening
`http://192.168.x.x:3000` does not. To test on a phone, use `npm run dev:https` (self-signed certificate,
which the phone must accept) or a tunnel such as `cloudflared tunnel --url http://localhost:3000`.

```bash
npm run build        # static site in out/ — host it on any static host
npm run preview      # serve out/ at http://localhost:4173 with the recommended security headers
npm test             # unit tests (parser, signatures, X.509, JPEG 2000, both QR engines)
npm run lint && npm run typecheck
```

`npm run demo:generate` regenerates the built-in samples (fictional data, synthetic avatar, V5 layout):
a fresh demo key signs them and is then deleted. `public/samples/demo-signed-qr.png` and
`demo-tampered-qr.png` are handy for testing the camera from a second screen.

### Checking a real card locally (opt-in)

```bash
mkdir private                                  # git-ignored, like *.pdf
AADHAAR_QR_IMAGE=private/qr.png npm run test:real
```

The test asserts structure only (format, signature status, field shapes) and prints nothing personal.
Never commit real Aadhaar data.

### Hosting

Any static host works (`out/`). If the host lets you set headers, send the same policy as a header, plus the
header-only directives (see `src/lib/security-policy.mjs` and `scripts/serve-out.mjs`):
`Content-Security-Policy` (+ `frame-ancestors 'none'`), `Referrer-Policy: no-referrer`,
`Permissions-Policy: camera=(self)`. For a sub-path deployment set `NEXT_PUBLIC_BASE_PATH=/your-path`
at build time. In production a service worker caches the app shell, decoder and WASM, so the app works
offline after the first visit.

## Privacy & security notes

- No backend, no analytics, no external fonts or CDNs. The CSP's `connect-src 'self'` stops the page from
  sending data elsewhere. Camera frames go only to an in-page Web Worker.
- Decoded data and the photo live in React state only. **Scan another**, reloading or closing the tab discards
  them. Nothing personal is written to `localStorage`, `IndexedDB`, cookies, the URL or the console.
- Older Aadhaar QR codes (plain XML, pre-2018) have no signature and contain the full Aadhaar number, so they
  are refused rather than displayed.
- A valid signature proves the **data** was issued by UIDAI and not altered. It does not prove the person
  holding the card is the resident: compare the photo. A QR can also be copied, so the generation timestamp
  shows how old the data is. Revocation cannot be checked offline.
- Uploading the e-Aadhaar PDF itself is not supported (it is password-protected). Use a screenshot of its QR.

## Project layout

```
src/app/                    layout (CSP, metadata), page, manifest, icon
src/components/             VerifierApp (state machine), ScannerView, ResultView, VerificationBanner, KeyManager
src/hooks/                  useQrCamera (stream + decode loop), useOfflineSupport (service worker)
src/lib/aadhaar/            payload → parse → verify, X.509 reader, keys, formatting, embedded UIDAI certs
src/lib/scanner/            engine (zxing-wasm / @zxing/library), worker + client, camera, frames, image files
src/lib/photo/              JPEG 2000 decode → JPEG data URL
scripts/                    copy-wasm, embed-uidai-certs, make-demo, serve-out, postbuild, payload builder
certs/uidai/                original UIDAI certificate files
tests/                      vitest suites (+ opt-in real-card check)
```

Independent open-source tool, not affiliated with UIDAI.
