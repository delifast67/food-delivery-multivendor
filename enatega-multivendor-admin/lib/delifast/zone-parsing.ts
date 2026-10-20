import type { DeliveryPoint } from './client';

export type DeliveryHours = { day: number; startMinute: number; endMinute: number };
export type ParseResult<T> = { value?: T; error?: string };

function point(value: unknown): DeliveryPoint | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { latitude?: unknown; longitude?: unknown };
  const latitude = Number(candidate.latitude);
  const longitude = Number(candidate.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
}

export function parsePolygonText(text: string): ParseResult<DeliveryPoint[] | null> {
  const raw = text.trim();
  if (!raw) return { value: null };
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return { error: 'Le polygone JSON doit être un tableau de points.' };
      const points = parsed.map(point);
      if (points.some((candidate) => candidate === null)) {
        return { error: 'Chaque point JSON doit contenir latitude et longitude numériques.' };
      }
      return { value: points as DeliveryPoint[] };
    } catch {
      return { error: 'Polygone JSON invalide : utilisez [{"latitude":0,"longitude":0}].' };
    }
  }
  const pairs = raw.split(';').map((pair) => pair.trim()).filter(Boolean);
  if (!pairs.length) return { error: 'Saisissez au moins un point lat,lng.' };
  const points: DeliveryPoint[] = [];
  for (const pair of pairs) {
    const values = pair.split(',').map((value) => Number(value.trim()));
    if (values.length !== 2 || values.some((value) => !Number.isFinite(value))) {
      return { error: 'Coordonnées invalides : utilisez lat,lng; lat,lng.' };
    }
    points.push({ latitude: values[0], longitude: values[1] });
  }
  return { value: points };
}

export function parseHoursText(text: string): ParseResult<DeliveryHours[]> {
  const raw = text.trim();
  if (!raw) return { value: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { error: 'Les horaires JSON doivent être un tableau.' };
    const hours = parsed.map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry as Record<string, unknown>;
      const day = Number(candidate.day);
      const startMinute = Number(candidate.startMinute);
      const endMinute = Number(candidate.endMinute);
      return Number.isInteger(day) && day >= 0 && day <= 6 && Number.isInteger(startMinute) && startMinute >= 0 && startMinute <= 1440 && Number.isInteger(endMinute) && endMinute >= 0 && endMinute <= 1440 && startMinute < endMinute
        ? { day, startMinute, endMinute }
        : null;
    });
    if (hours.some((entry) => entry === null)) {
      return { error: 'Chaque horaire doit avoir day 0–6, startMinute/endMinute 0–1440, début < fin.' };
    }
    return { value: hours as DeliveryHours[] };
  } catch {
    return { error: 'Horaires JSON invalides : utilisez [{"day":1,"startMinute":480,"endMinute":1200}].' };
  }
}
