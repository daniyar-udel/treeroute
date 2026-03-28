import { PROFILE_STORAGE_KEY, ROUTE_DRAFT_STORAGE_KEY } from "@/lib/constants";
import type { UserProfile, WaypointInput } from "@/lib/types";

export function loadStoredProfile(): UserProfile | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as UserProfile) : null;
  } catch {
    return null;
  }
}

export function saveStoredProfile(profile: UserProfile) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
}

export function clearStoredProfile() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(PROFILE_STORAGE_KEY);
}

export interface RouteDraft {
  origin: WaypointInput;
  destination: WaypointInput;
}

export function loadRouteDraft(): RouteDraft | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(ROUTE_DRAFT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RouteDraft) : null;
  } catch {
    return null;
  }
}

export function saveRouteDraft(draft: RouteDraft) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(ROUTE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

export function clearRouteDraft() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(ROUTE_DRAFT_STORAGE_KEY);
}
