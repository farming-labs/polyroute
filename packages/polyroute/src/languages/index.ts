import path from "node:path";
import { component } from "./component.js";
import { python } from "./python.js";
import { rust } from "./rust.js";
import type { Language } from "./types.js";

export type { Language, RouteBuildInput, RouteBuildResult } from "./types.js";

export const LANGUAGES: readonly Language[] = [rust, python, component];

export function findLanguage(file: string): Language | undefined {
  const extension = path.extname(file);
  return LANGUAGES.find((language) => language.extensions.includes(extension));
}
