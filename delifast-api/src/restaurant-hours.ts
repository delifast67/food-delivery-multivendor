import { fail } from "./validation.js";

export type RestaurantHours = { day: number; startMinute: number; endMinute: number };
export type RestaurantHoursInput = RestaurantHours;

const MAX_SLOTS = 28;

/** Canonical, bounded weekly schedule. null means legacy/unrestricted; [] means closed. */
export function normalizeRestaurantSchedule(raw: unknown): RestaurantHours[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > MAX_SLOTS) fail("INVALID_INPUT", "Horaires restaurant invalides");
  const value = raw.map((entry: any) => {
    if (!entry || typeof entry !== "object" || !Number.isInteger(entry.day) || entry.day < 0 || entry.day > 6 ||
      !Number.isInteger(entry.startMinute) || entry.startMinute < 0 || entry.startMinute > 1439 ||
      !Number.isInteger(entry.endMinute) || entry.endMinute < 1 || entry.endMinute > 1440 ||
      entry.endMinute <= entry.startMinute) {
      fail("INVALID_INPUT", "Horaires restaurant invalides");
    }
    return { day: entry.day, startMinute: entry.startMinute, endMinute: entry.endMinute };
  }).sort((a, b) => a.day - b.day || a.startMinute - b.startMinute || a.endMinute - b.endMinute);
  for (let i = 1; i < value.length; i++) {
    const previous = value[i - 1], current = value[i];
    if (current.day === previous.day && current.startMinute < previous.endMinute)
      fail("INVALID_INPUT", "Créneaux restaurant superposés");
  }
  return value;
}

/** Ouagadougou is UTC: no host-local timezone conversion is involved. */
export function isRestaurantOpen(restaurant: any, now = new Date()): boolean {
  if (restaurant?.open === false) return false;
  const schedule = restaurant?.weeklySchedule;
  if (schedule == null) return true;
  if (!Array.isArray(schedule) || schedule.length === 0) return false;
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  return schedule.some((slot: RestaurantHours) => slot.day === now.getUTCDay() && minute >= slot.startMinute && minute < slot.endMinute);
}

export function resolvedRestaurantSchedule(restaurant: any): RestaurantHours[] | null {
  return restaurant?.weeklySchedule == null ? null : restaurant.weeklySchedule;
}
