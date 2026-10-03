"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import ProductConfirmDialog from "@/components/product/ProductConfirmDialog";
import { Button } from "@/components/product/WorkspaceUI";
import {
  CHANNEL_COLORS,
  readChannelColors,
  setChannelColor,
  setChannelHidden,
  type ChannelColorKey,
} from "@/lib/channel-prefs";

export const CHANNELS_CHANGED_EVENT = "m9r:channels-changed";

export interface EditableChannel {
  id: string;
  /** The stored name, without the display formatting. */
  topic: string;
  description: string | null;
  kind: "channel" | "dm";
  /** Built-in channels (General, Agents, Activity) cannot be renamed or deleted. */
  builtIn: boolean;
}

/**
 * Edit a channel: its name, purpose and the colour of its mascot, or delete it. Built-in channels keep their name and
 * cannot be deleted (the server refuses both); they can be recoloured, given a purpose, or hidden from the sidebar.
 */
export default function ChannelEditDialog({ channel, onClose }: { channel: EditableChannel; onClose: () => void }) {
  const router = useRouter();
  const nameId = useId();
  const purposeId = useId();
  const [name, setName] = useState(channel.topic);
  const [description, setDescription] = useState(channel.description ?? "");
  const [color, setColor] = useState<ChannelColorKey | null>(null);
  const [hide, setHide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isDm = channel.kind === "dm";

  useEffect(() => {
    const stored = readChannelColors()[channel.id] ?? null;
    queueMicrotask(() => setColor(stored));
  }, [channel.id]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy && !confirmDelete) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, confirmDelete, onClose]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const changes: Record<string, unknown> = {};
      if (!channel.builtIn && !isDm && name.trim() !== channel.topic) changes.name = name;
      if (!isDm && description.trim() !== (channel.description ?? "")) changes.description = description;
      if (Object.keys(changes).length > 0) {
        const response = await fetch(`/api/dashboard/conversations/${channel.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "update", ...changes }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "Could not save the channel.");
        }
      }
      setChannelColor(channel.id, color);
      if (channel.builtIn) setChannelHidden(channel.id, hide);
      window.dispatchEvent(new Event(CHANNELS_CHANGED_EVENT));
      router.refresh();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the channel.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/dashboard/conversations/${channel.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not delete the channel.");
      }
      setChannelColor(channel.id, null);
      setChannelHidden(channel.id, false);
      window.dispatchEvent(new Event(CHANNELS_CHANGED_EVENT));
      onClose();
      router.push("/dashboard/agents");
      router.refresh();
    } catch (caught) {
      setConfirmDelete(false);
      setError(caught instanceof Error ? caught.message : "Could not delete the channel.");
    } finally {
      setBusy(false);
    }
  }

  const label = isDm ? channel.topic : `#${channel.topic}`;
  const noun = isDm ? "conversation" : "channel";

  return (
    <div className="ol-dialog-overlay" role="dialog" aria-modal="true" aria-label={`Edit ${label}`} onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="ol-dialog m9r-edit-channel">
        <h2 className="ol-dialog__title">{isDm ? "Edit conversation" : "Edit channel"}</h2>

        {!isDm && (
          <>
            <label className="m9r-edit-field" htmlFor={nameId}>
              <span className="bs-micro">Name</span>
              <input id={nameId} type="text" value={name} maxLength={80} disabled={channel.builtIn || busy} onChange={(event) => setName(event.target.value)} />
              {channel.builtIn && <small>Built-in channels keep their name.</small>}
            </label>
            <label className="m9r-edit-field" htmlFor={purposeId}>
              <span className="bs-micro">Purpose</span>
              <input id={purposeId} type="text" value={description} maxLength={240} disabled={busy} placeholder="What this channel is for" onChange={(event) => setDescription(event.target.value)} />
            </label>
          </>
        )}

        <fieldset className="m9r-edit-field m9r-edit-colors" disabled={busy}>
          <legend className="bs-micro">Mascot colour</legend>
          <div role="radiogroup" aria-label="Mascot colour">
            <button type="button" role="radio" aria-checked={color === null} className="m9r-swatch m9r-swatch-default" data-on={color === null || undefined} onClick={() => setColor(null)} title="Default">
              <span>Auto</span>
            </button>
            {(Object.entries(CHANNEL_COLORS) as Array<[ChannelColorKey, (typeof CHANNEL_COLORS)[ChannelColorKey]]>).map(([key, value]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={color === key}
                aria-label={value.label}
                title={value.label}
                className="m9r-swatch"
                data-on={color === key || undefined}
                onClick={() => setColor(key)}
                style={{ background: `linear-gradient(135deg, ${value.gradient[0]}, ${value.gradient[1]} 55%, ${value.gradient[2]})` }}
              />
            ))}
          </div>
        </fieldset>

        {channel.builtIn && (
          <label className="m9r-edit-check">
            <input type="checkbox" checked={hide} disabled={busy} onChange={(event) => setHide(event.target.checked)} />
            <span>Hide from the sidebar (show hidden channels again from the list)</span>
          </label>
        )}

        {error && <p className="m9r-edit-error" role="alert">{error}</p>}

        <div className="m9r-edit-actions">
          {!channel.builtIn ? (
            <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>{`Delete ${noun}`}</Button>
          ) : (
            <span className="m9r-edit-note">Built-in channels can not be deleted.</span>
          )}
          <span className="flex-1" />
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={busy || (!isDm && !channel.builtIn && name.trim().length === 0)} onClick={() => void save()}>Save</Button>
        </div>
      </div>

      <ProductConfirmDialog
        open={confirmDelete}
        title={`Delete ${label}?`}
        description="This permanently removes the channel and every message in it. It cannot be undone."
        confirmLabel={`Delete ${noun}`}
        busy={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
