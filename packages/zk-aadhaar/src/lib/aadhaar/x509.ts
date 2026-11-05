// SPDX-License-Identifier: MIT
import { base64ToBytes, bytesToHex, concatBytes, type Bytes } from "./bytes";

/**
 * Minimal, dependency-free reader for RSA public keys in the formats UIDAI and
 * typical tooling produce: X.509 certificates (PEM or DER .cer), SPKI
 * "PUBLIC KEY" blocks and PKCS#1 "RSA PUBLIC KEY" blocks. It extracts the
 * SubjectPublicKeyInfo for Web Crypto plus display metadata. It does not
 * validate certificate chains — trust comes from pinning, not from the CA.
 */

const RSA_ENCRYPTION_OID = "1.2.840.113549.1.1.1";

export interface DistinguishedName {
  commonName: string | null;
  organization: string | null;
  organizationalUnit: string | null;
  country: string | null;
  text: string;
}

export interface ParsedPublicKey {
  kind: "certificate" | "public-key";
  /** DER SubjectPublicKeyInfo, ready for `crypto.subtle.importKey("spki", …)`. */
  spki: Bytes;
  /** DER of the whole object (certificate or key), for fingerprints. */
  der: Bytes;
  modulusBits: number;
  publicExponent: number | null;
  subject: DistinguishedName | null;
  issuer: DistinguishedName | null;
  notBefore: Date | null;
  notAfter: Date | null;
  serialNumber: string | null;
}

export class KeyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyParseError";
  }
}

class UnsupportedKeyError extends KeyParseError {}

interface Tlv {
  tag: number;
  start: number;
  headerLength: number;
  end: number;
}

function readTlv(der: Uint8Array, pos: number, limit = der.length): Tlv {
  if (pos + 2 > limit) throw new KeyParseError("Truncated DER data");
  const tag = der[pos];
  if ((tag & 0x1f) === 0x1f) throw new KeyParseError("Unsupported DER tag");
  let length = der[pos + 1];
  let headerLength = 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 4) throw new KeyParseError("Unsupported DER length");
    if (pos + 2 + n > limit) throw new KeyParseError("Truncated DER data");
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + der[pos + 2 + i];
    headerLength += n;
  }
  const end = pos + headerLength + length;
  if (end > limit) throw new KeyParseError("Truncated DER data");
  return { tag, start: pos, headerLength, end };
}

function children(der: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let pos = parent.start + parent.headerLength;
  while (pos < parent.end) {
    const child = readTlv(der, pos, parent.end);
    out.push(child);
    pos = child.end;
  }
  return out;
}

const contentOf = (der: Uint8Array, tlv: Tlv) => der.subarray(tlv.start + tlv.headerLength, tlv.end);
const wholeOf = (der: Uint8Array, tlv: Tlv): Bytes => {
  const out = new Uint8Array(tlv.end - tlv.start);
  out.set(der.subarray(tlv.start, tlv.end));
  return out;
};

function expect(tlv: Tlv | undefined, tag: number, what: string): Tlv {
  if (!tlv || tlv.tag !== tag) throw new KeyParseError(`Invalid ${what}`);
  return tlv;
}

function decodeOid(bytes: Uint8Array): string {
  const parts: number[] = [];
  let value = 0;
  for (const byte of bytes) {
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      if (parts.length === 0) {
        const first = value < 80 ? Math.floor(value / 40) : 2;
        parts.push(first, value - first * 40);
      } else {
        parts.push(value);
      }
      value = 0;
    }
  }
  return parts.join(".");
}

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

function decodeString(der: Uint8Array, tlv: Tlv): string {
  const bytes = contentOf(der, tlv);
  if (tlv.tag === 0x0c) return utf8.decode(bytes); // UTF8String
  if (tlv.tag === 0x1e) {
    // BMPString (UTF-16BE)
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  return latin1.decode(bytes); // PrintableString, IA5String, T61String, …
}

const NAME_ATTRIBUTES: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.5": "SERIALNUMBER",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.9": "STREET",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.17": "postalCode",
};

function parseName(der: Uint8Array, name: Tlv): DistinguishedName {
  const pairs: Array<[string, string]> = [];
  for (const rdn of children(der, name)) {
    for (const attribute of children(der, rdn)) {
      const [type, value] = children(der, attribute);
      if (!type || !value || type.tag !== 0x06) continue;
      const oid = decodeOid(contentOf(der, type));
      pairs.push([NAME_ATTRIBUTES[oid] ?? oid, decodeString(der, value)]);
    }
  }
  const get = (key: string) => pairs.find(([k]) => k === key)?.[1] ?? null;
  return {
    commonName: get("CN"),
    organization: get("O"),
    organizationalUnit: get("OU"),
    country: get("C"),
    text: pairs.map(([k, v]) => `${k}=${v}`).join(", "),
  };
}

function parseTime(der: Uint8Array, tlv: Tlv): Date {
  const s = latin1.decode(contentOf(der, tlv));
  const m =
    tlv.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s)
      : tlv.tag === 0x18
        ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(s)
        : null;
  if (!m) throw new KeyParseError("Unsupported certificate validity format");
  let year = Number(m[1]);
  if (tlv.tag === 0x17) year += year >= 50 ? 1900 : 2000;
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
}

function parseRsaPublicKey(rsa: Uint8Array): { modulusBits: number; publicExponent: number | null } {
  const sequence = expect(readTlv(rsa, 0), 0x30, "RSA public key");
  const [n, e] = children(rsa, sequence);
  let modulus = contentOf(rsa, expect(n, 0x02, "RSA modulus"));
  const exponent = contentOf(rsa, expect(e, 0x02, "RSA exponent"));
  let i = 0;
  while (i < modulus.length - 1 && modulus[i] === 0) i++;
  modulus = modulus.subarray(i);
  const modulusBits = (modulus.length - 1) * 8 + (32 - Math.clz32(modulus[0]));
  let publicExponent: number | null = null;
  if (exponent.length <= 6) {
    publicExponent = 0;
    for (const byte of exponent) publicExponent = publicExponent * 256 + byte;
  }
  return { modulusBits, publicExponent };
}

function parseSpki(der: Uint8Array, spki: Tlv) {
  const [algorithm, subjectPublicKey] = children(der, spki);
  const [oid] = children(der, expect(algorithm, 0x30, "public key algorithm"));
  if (decodeOid(contentOf(der, expect(oid, 0x06, "public key algorithm"))) !== RSA_ENCRYPTION_OID) {
    throw new UnsupportedKeyError("Only RSA public keys are supported (UIDAI signs Secure QR codes with RSA-2048).");
  }
  const bits = contentOf(der, expect(subjectPublicKey, 0x03, "public key"));
  if (bits[0] !== 0) throw new KeyParseError("Invalid public key encoding");
  return parseRsaPublicKey(bits.subarray(1));
}

function parseCertificateDer(der: Uint8Array): ParsedPublicKey {
  const certificate = expect(readTlv(der, 0), 0x30, "certificate");
  const [tbs] = children(der, certificate);
  const fields = children(der, expect(tbs, 0x30, "certificate"));
  let i = fields[0]?.tag === 0xa0 ? 1 : 0; // optional explicit version
  const serial = expect(fields[i++], 0x02, "certificate serial number");
  i++; // signature algorithm
  const issuer = expect(fields[i++], 0x30, "certificate issuer");
  const validity = expect(fields[i++], 0x30, "certificate validity");
  const subject = expect(fields[i++], 0x30, "certificate subject");
  const spki = expect(fields[i++], 0x30, "certificate public key");
  const [notBefore, notAfter] = children(der, validity);
  if (!notBefore || !notAfter) throw new KeyParseError("Invalid certificate validity");

  return {
    kind: "certificate",
    spki: wholeOf(der, spki),
    der: wholeOf(der, certificate),
    ...parseSpki(der, spki),
    subject: parseName(der, subject),
    issuer: parseName(der, issuer),
    notBefore: parseTime(der, notBefore),
    notAfter: parseTime(der, notAfter),
    serialNumber: bytesToHex(contentOf(der, serial)).replace(/^(00)+(?=.)/, "").toUpperCase(),
  };
}

function parseSpkiDer(der: Uint8Array): ParsedPublicKey {
  const spki = expect(readTlv(der, 0), 0x30, "public key");
  const info = parseSpki(der, spki);
  const bytes = wholeOf(der, spki);
  return {
    kind: "public-key",
    spki: bytes,
    der: bytes,
    ...info,
    subject: null,
    issuer: null,
    notBefore: null,
    notAfter: null,
    serialNumber: null,
  };
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

const derTlv = (tag: number, content: Uint8Array) => concatBytes(Uint8Array.of(tag), derLength(content.length), content);

function parsePkcs1Der(der: Uint8Array): ParsedPublicKey {
  const rsa = wholeOf(der, expect(readTlv(der, 0), 0x30, "RSA public key"));
  const info = parseRsaPublicKey(rsa);
  // SEQUENCE { SEQUENCE { rsaEncryption, NULL }, BIT STRING { 0x00 ‖ RSAPublicKey } }
  const algorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  const spki = derTlv(0x30, concatBytes(algorithm, derTlv(0x03, concatBytes(Uint8Array.of(0), rsa))));
  return {
    kind: "public-key",
    spki,
    der: spki,
    ...info,
    subject: null,
    issuer: null,
    notBefore: null,
    notAfter: null,
    serialNumber: null,
  };
}

function parseDer(der: Uint8Array): ParsedPublicKey {
  for (const parse of [parseCertificateDer, parseSpkiDer, parsePkcs1Der]) {
    try {
      return parse(der);
    } catch (error) {
      if (error instanceof UnsupportedKeyError) throw error;
    }
  }
  throw new KeyParseError("Unrecognised certificate or key format.");
}

/**
 * Parses every public key in the input: PEM text (one or more blocks), bare
 * base64, or DER bytes from a .cer/.der file.
 */
export function parsePublicKeys(input: string | Uint8Array): ParsedPublicKey[] {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    if (input[0] === 0x30) return [parseDer(input)];
    text = latin1.decode(input);
  }

  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    throw new KeyParseError(
      "That is a private key. Only a certificate or public key is needed — never paste or share a private key.",
    );
  }

  const blocks = [...text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g)];
  if (blocks.length > 0) {
    return blocks.map(([, label, body]) => {
      const der = base64ToBytes(body);
      switch (label) {
        case "CERTIFICATE":
        case "X509 CERTIFICATE":
        case "TRUSTED CERTIFICATE":
          return parseCertificateDer(der);
        case "PUBLIC KEY":
          return parseSpkiDer(der);
        case "RSA PUBLIC KEY":
          return parsePkcs1Der(der);
        default:
          throw new KeyParseError(`Unsupported PEM block "${label}".`);
      }
    });
  }

  const compact = text.replace(/\s+/g, "");
  if (compact.length > 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return [parseDer(base64ToBytes(compact))];
  }

  throw new KeyParseError(
    "No certificate or public key found. Paste a PEM block (-----BEGIN CERTIFICATE----- …) or choose a .cer / .pem file.",
  );
}
