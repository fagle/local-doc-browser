import { existsSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";

export function isWindowsDrivePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

export function normalizeInputPath(value) {
  const rawPath = String(value || "").trim();
  if (!rawPath) return "";

  if (platform() !== "win32") {
    const legacyMount = process.env.LEGACY_NAS_MOUNT || "";
    const mappedMount = process.env.LEGACY_NAS_MAPPED_MOUNT || "";
    if (legacyMount && mappedMount && (rawPath === legacyMount || rawPath.startsWith(`${legacyMount}/`))) {
      const rest = rawPath.slice(legacyMount.length).replace(/^\/+/, "");
      const mountedDrivePath = resolve(mappedMount, rest);
      if (existsSync(mountedDrivePath)) return mountedDrivePath;
    }
  }

  if (platform() === "win32") {
    const legacyMount = process.env.LEGACY_NAS_MOUNT || "";
    const windowsNasDrive = process.env.WINDOWS_NAS_DRIVE || "";
    if (legacyMount && windowsNasDrive && (rawPath === legacyMount || rawPath.startsWith(`${legacyMount}/`))) {
      const rest = rawPath.slice(legacyMount.length).replace(/^\/+/, "").replaceAll("/", "\\");
      return resolve(windowsNasDrive, rest);
    }
  }

  if (platform() !== "win32" && isWindowsDrivePath(rawPath)) {
    const drive = rawPath[0].toLowerCase();
    const rest = rawPath.slice(2).replaceAll("\\", "/").replace(/^\/+/, "");
    const mountedDrivePath = resolve(`/mnt/${drive}/${rest}`);
    if (existsSync(mountedDrivePath)) return mountedDrivePath;

    const configuredMount = process.env[`WSL_DRIVE_${drive.toUpperCase()}`] || process.env[`WINDOWS_DRIVE_${drive.toUpperCase()}`];
    if (configuredMount) {
      const configuredPath = resolve(configuredMount, rest);
      if (existsSync(configuredPath)) return configuredPath;
    }

    const fallbackMount = process.env.WINDOWS_DRIVE_FALLBACK_MOUNT || "";
    if (fallbackMount) {
      const fallbackPath = resolve(fallbackMount, rest);
      if (existsSync(fallbackPath)) return fallbackPath;
    }

    return mountedDrivePath;
  }

  return resolve(rawPath);
}

export function displayPath(value) {
  if (platform() !== "win32") {
    const match = value.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
    if (match) {
      const drive = match[1].toUpperCase();
      const rest = (match[2] || "").replaceAll("/", "\\");
      return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
    }
  }

  return value;
}
