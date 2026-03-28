import { ALLERGY_TRIGGER_OPTIONS } from "@/lib/constants";
import type { UserProfile } from "@/lib/types";

export const DEFAULT_PROFILE: UserProfile = {
  name: "",
  email: "",
  triggers: [],
  sensitivity: "medium",
  notes: "",
  registrationComplete: false,
  knowsTreeTriggers: true,
};

export function normalizeProfile(profile: UserProfile | null): UserProfile {
  if (!profile) {
    return DEFAULT_PROFILE;
  }

  const knownTriggers = ALLERGY_TRIGGER_OPTIONS.filter((trigger) => profile.triggers.includes(trigger));

  return {
    ...DEFAULT_PROFILE,
    ...profile,
    triggers: knownTriggers,
    knowsTreeTriggers: profile.knowsTreeTriggers ?? knownTriggers.length > 0,
    registrationComplete: profile.registrationComplete ?? false,
  };
}

export function isRegistered(profile: UserProfile | null) {
  if (!profile) {
    return false;
  }

  const normalized = normalizeProfile(profile);
  const hasIdentity = Boolean(normalized.name?.trim() && normalized.email?.trim());
  const hasTreeMode = !normalized.knowsTreeTriggers || normalized.triggers.length > 0;

  return hasIdentity && hasTreeMode && Boolean(normalized.registrationComplete);
}
