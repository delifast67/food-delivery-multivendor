'use client';
import { useRef, useState } from 'react';
import type { Restaurant, RestaurantHours } from '@/lib/delifast/client';

const DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
export function parseScheduleRows(rows: RestaurantHours[]): RestaurantHours[] {
  if (rows.length > 28) throw new Error('Maximum 28 créneaux par semaine.');
  const sorted = rows.map(({ day, startMinute, endMinute }) => {
    if (!Number.isInteger(day) || day < 0 || day > 6 || !Number.isInteger(startMinute) || startMinute < 0 || startMinute > 1439 || !Number.isInteger(endMinute) || endMinute < 1 || endMinute > 1440 || startMinute >= endMinute) {
      throw new Error('Chaque créneau doit avoir un jour et une heure de fin après le début. Pour passer minuit, utilisez deux créneaux.');
    }
    return { day, startMinute, endMinute };
  }).sort((a, b) => a.day - b.day || a.startMinute - b.startMinute);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].day === sorted[i - 1].day && sorted[i].startMinute < sorted[i - 1].endMinute) {
      throw new Error('Deux créneaux du même jour se chevauchent.');
    }
  }
  return sorted;
}
const minuteOf = (value: string) => /^\d{2}:\d{2}$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;
type Props = {
  restaurants: Restaurant[];
  busy: boolean;
  save: (id: string, version: number, schedule: RestaurantHours[] | null) => Promise<boolean>;
};
export default function RestaurantSchedule({ restaurants, busy, save }: Props) {
  const [editing, setEditing] = useState<{ id: string; version: number } | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [rows, setRows] = useState<RestaurantHours[]>([]);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const saving = useRef(false);
  const edit = (restaurant: Restaurant) => {
    setEditing({ id: restaurant.id, version: restaurant.version });
    setRestricted(restaurant.weeklySchedule != null);
    setRows((restaurant.weeklySchedule ?? []).map(row => ({ ...row })));
    setError(''); setBlocked(false);
  };
  const change = (index: number, key: keyof RestaurantHours, value: number) => setRows(current => current.map((row, i) => i === index ? { ...row, [key]: value } : row));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing || busy || blocked || saving.current) return;
    let schedule: RestaurantHours[] | null;
    try { schedule = restricted ? parseScheduleRows(rows) : null; }
    catch (e) { setError(e instanceof Error ? e.message : 'Horaires invalides'); return; }
    saving.current = true; setError('');
    try {
      if (await save(editing.id, editing.version, schedule)) setEditing(null);
      else { setBlocked(true); setError('Enregistrement non confirmé. Actualisez les opérations, puis rechargez les horaires affichés avant toute nouvelle écriture. Le brouillon reste visible.'); }
    } catch {
      setBlocked(true); setError('Résultat réseau incertain. Actualisez les opérations, puis rechargez les horaires affichés avant toute nouvelle écriture.');
    } finally { saving.current = false; }
  };
  const selected = restaurants.find(restaurant => restaurant.id === editing?.id);
  return <section className="df-card">
    <p className="df-kicker">HORAIRES RESTAURANT</p><h2>Disponibilité hebdomadaire</h2>
    <p className="df-muted">Heures UTC / Ouagadougou. L’interrupteur manuel « ouvert » reste nécessaire, même pendant les créneaux. Les horaires des zones de livraison s’appliquent aussi. Aucun horaire commercial réel n’est prérempli.</p>
    <div className="df-restaurant-list">{restaurants.map(restaurant => <div key={restaurant.id}>
      <div><b>{restaurant.name}</b><small>v{restaurant.version} · {restaurant.weeklySchedule == null ? 'Sans restriction horaire' : restaurant.weeklySchedule.length === 0 ? 'Fermé toute la semaine' : `${restaurant.weeklySchedule.length} créneau(x)`}</small></div>
      <button type="button" disabled={busy || saving.current} onClick={() => edit(restaurant)}>{editing?.id === restaurant.id ? 'Recharger les horaires affichés' : 'Modifier les horaires'}</button>
    </div>)}</div>
    {editing && <form className="df-profile-form" onSubmit={submit}>
      <strong>{selected?.name ?? editing.id} · version d’édition {editing.version}</strong>
      <label className="df-check"><input type="checkbox" checked={restricted} disabled={busy || blocked} onChange={e => setRestricted(e.target.checked)} /> Restreindre aux créneaux ci-dessous</label>
      {!restricted && <p>Sans restriction horaire : seule l’ouverture manuelle et la disponibilité des zones limitent les commandes.</p>}
      {restricted && <>
        <p>Aucun créneau = fermé toute la semaine. Début inclus, fin exclue. Pour un service de nuit, séparez avant et après minuit sur les jours correspondants.</p>
        {rows.map((row, index) => <fieldset key={index} disabled={busy || blocked}>
          <legend>Créneau {index + 1}</legend>
          <label>Jour<select value={row.day} onChange={e => change(index, 'day', Number(e.target.value))}>{DAYS.map((day, value) => <option key={day} value={value}>{day}</option>)}</select></label>
          <label>Début<input type="time" required value={Number.isFinite(row.startMinute) ? clock(row.startMinute) : ''} onChange={e => change(index, 'startMinute', minuteOf(e.target.value))} /></label>
          <label>Fin<input type="time" required={row.endMinute !== 1440} disabled={row.endMinute === 1440} value={Number.isFinite(row.endMinute) && row.endMinute !== 1440 ? clock(row.endMinute) : ''} onChange={e => change(index, 'endMinute', minuteOf(e.target.value))} /></label>
          <label className="df-check"><input type="checkbox" checked={row.endMinute === 1440} onChange={e => change(index, 'endMinute', e.target.checked ? 1440 : 1380)} /> Fin à minuit (24:00)</label>
          <button type="button" className="df-secondary" onClick={() => setRows(current => current.filter((_, i) => i !== index))}>Retirer ce créneau</button>
        </fieldset>)}
        <button type="button" className="df-secondary" disabled={busy || blocked || rows.length >= 28} onClick={() => setRows(current => [...current, { day: 1, startMinute: 720, endMinute: 840 }])}>Ajouter un créneau à vérifier</button>
      </>}
      {error && <p className="df-error" role="alert">{error}</p>}
      <div className="df-button-row"><button disabled={busy || blocked || saving.current}>Enregistrer les horaires</button><button type="button" className="df-secondary" disabled={busy} onClick={() => { setEditing(null); setError(''); setBlocked(false); }}>Annuler le brouillon</button></div>
    </form>}
  </section>;
}
