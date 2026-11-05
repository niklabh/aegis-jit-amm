// SPDX-License-Identifier: MIT
import type { DecodedQr, DecodeMode, EngineName, EngineOptions } from "./engine";

export type DecoderRequest =
  | { type: "init"; options: EngineOptions }
  | { type: "decode"; id: number; width: number; height: number; buffer: ArrayBuffer; mode: DecodeMode };

export type DecoderResponse =
  | { type: "ready"; engine: EngineName; resources: string[] }
  | { type: "init-failed"; message: string }
  | { type: "result"; id: number; result: DecodedQr | null; error?: string };
