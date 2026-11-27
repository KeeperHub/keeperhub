"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import type { CoverageGap } from "@/lib/rpc/engine/org/coverage";
import type { OrgRpcConfigView } from "@/lib/rpc/engine/org/service";
import type { RpcConfigUrlSlot } from "@/lib/rpc/engine/org/url-slots";
import type { RpcChainType } from "@/lib/rpc/engine/types";
import type {
  CreateRpcConfigBody,
  RpcChainOption,
  UpdateRpcConfigBody,
} from "@/lib/rpc/org-rpc-client";
import {
  AutoFallbackChange,
  AutoFallbackConfirm,
  type AutoFallbackPrompt,
} from "./auto-fallback-confirm";
import { ChainBadges, ChainPicker } from "./chain-picker";
import { CoverageGapList } from "./coverage-gaps";
import {
  buildCreateBody,
  buildUpdateBody,
  type CreateDraft,
  type EditDraft,
  editDraftFor,
  filledSlots,
  formErrorsFrom,
  hasChanges,
  NO_FORM_ERRORS,
  REQUIRED_SLOT,
  type RpcFormErrors,
  SLOT_LABEL,
  slotPlaceholder,
  slotsForChainType,
  type UrlDraft,
} from "./model";

const DEFAULT_LABEL = "Default for this chain";

const DEFAULT_HINT =
  "Steps set to Auto use the chain's default endpoint. Without one, they use KeeperHub's endpoints.";

const SAVED_URL_PLACEHOLDER = "Saved. Paste a new URL to replace it.";

const URL_NOTE =
  "Each URL is tested against the chain before it is saved. Saved URLs are never shown again, not even in part.";

function FieldError({
  id,
  message,
}: {
  id: string;
  message: string | undefined;
}): React.ReactNode {
  if (!message) {
    return null;
  }
  return (
    <p className="text-destructive text-xs" id={id} role="alert">
      {message}
    </p>
  );
}

function UrlField({
  slot,
  value,
  placeholder,
  error,
  onChange,
  cleared = false,
  onToggleClear,
}: {
  slot: RpcConfigUrlSlot;
  value: string;
  placeholder: string;
  error: string | undefined;
  onChange: (next: string) => void;
  cleared?: boolean;
  /** Offered for a saved optional URL: mark it for removal, or undo that. */
  onToggleClear?: () => void;
}): React.ReactElement {
  const id = useId();
  const errorId = `${id}-error`;
  const required = slot === REQUIRED_SLOT;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>
          {SLOT_LABEL[slot]}
          {required ? "" : " (optional)"}
        </Label>
        {onToggleClear && (
          <Button
            className="h-auto px-1 py-0 text-xs"
            onClick={onToggleClear}
            size="sm"
            type="button"
            variant="ghost"
          >
            {cleared ? "Keep" : "Remove"}
          </Button>
        )}
      </div>
      <Input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={Boolean(error)}
        autoComplete="off"
        className="font-mono text-xs"
        disabled={cleared}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        placeholder={cleared ? "Will be removed" : placeholder}
        spellCheck={false}
        type="url"
        value={cleared ? "" : value}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function NameField({
  value,
  error,
  onChange,
}: {
  value: string;
  error: string | undefined;
  onChange: (next: string) => void;
}): React.ReactElement {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Name</Label>
      <Input
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={Boolean(error)}
        id={id}
        maxLength={64}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Main provider"
        value={value}
      />
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function SwitchField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): React.ReactElement {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      <Switch checked={checked} id={id} onCheckedChange={onChange} />
    </div>
  );
}

function FormProblem({
  errors,
  chainName,
}: {
  errors: RpcFormErrors;
  chainName: (chainId: number) => string;
}): React.ReactNode {
  if (!errors.form) {
    return null;
  }
  return (
    <Notice role="alert" tone="danger">
      <div className="flex flex-col gap-2">
        <span>{errors.form}</span>
        {errors.gaps.length > 0 && (
          <CoverageGapList chainName={chainName} gaps={errors.gaps} />
        )}
      </div>
    </Notice>
  );
}

const EMPTY_CREATE: CreateDraft = {
  chain: null,
  name: "",
  urls: {},
  isDefault: false,
};

export function AddRpcConfigDialog({
  open,
  onOpenChange,
  chains,
  chainName,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  chains: readonly RpcChainOption[];
  chainName: (chainId: number) => string;
  onCreate: (body: CreateRpcConfigBody) => Promise<unknown>;
}): React.ReactElement {
  const [draft, setDraft] = useState<CreateDraft>(EMPTY_CREATE);
  const [errors, setErrors] = useState<RpcFormErrors>(NO_FORM_ERRORS);
  const [saving, setSaving] = useState(false);
  const chainSelectId = useId();

  useEffect(() => {
    if (open) {
      setDraft(EMPTY_CREATE);
      setErrors(NO_FORM_ERRORS);
    }
  }, [open]);

  // Typed URLs carry API keys, so they are dropped as the dialog closes.
  const changeOpen = (next: boolean): void => {
    if (!next) {
      setDraft(EMPTY_CREATE);
      setErrors(NO_FORM_ERRORS);
    }
    onOpenChange(next);
  };

  const body = buildCreateBody(draft);
  const slots = draft.chain ? slotsForChainType(draft.chain.chainType) : [];

  const setUrl = (slot: RpcConfigUrlSlot, value: string): void => {
    setDraft((current) => ({
      ...current,
      urls: { ...current.urls, [slot]: value },
    }));
    setErrors((current) => ({
      ...current,
      slots: { ...current.slots, [slot]: undefined },
    }));
  };

  const submit = async (): Promise<void> => {
    if (!body) {
      return;
    }
    setSaving(true);
    setErrors(NO_FORM_ERRORS);
    try {
      await onCreate(body);
      changeOpen(false);
    } catch (error) {
      setErrors(formErrorsFrom(error, "Could not save the RPC config."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add RPC endpoint</DialogTitle>
          <DialogDescription>{URL_NOTE}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={chainSelectId}>Chain</Label>
            <ChainPicker
              chains={chains}
              id={chainSelectId}
              onChange={(chain) =>
                setDraft((current) => ({ ...current, chain }))
              }
              value={draft.chain}
            />
          </div>

          <NameField
            error={errors.name}
            onChange={(name) => {
              setDraft((current) => ({ ...current, name }));
              setErrors((current) => ({ ...current, name: undefined }));
            }}
            value={draft.name}
          />

          {slots.map((slot) => (
            <UrlField
              error={errors.slots[slot]}
              key={slot}
              onChange={(value) => setUrl(slot, value)}
              placeholder={slotPlaceholder(slot)}
              slot={slot}
              value={draft.urls[slot] ?? ""}
            />
          ))}

          {draft.chain && (
            <SwitchField
              checked={draft.isDefault}
              hint="Steps set to Auto use the chain's default endpoint. The first endpoint on a chain becomes its default."
              label="Make default for this chain"
              onChange={(isDefault) =>
                setDraft((current) => ({ ...current, isDefault }))
              }
            />
          )}

          <FormProblem chainName={chainName} errors={errors} />

          <DialogFooter>
            <Button
              disabled={saving}
              onClick={() => changeOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={!body || saving} type="submit">
              {saving ? "Testing and saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function editableSlots(
  config: OrgRpcConfigView,
  chainType: RpcChainType | null
): readonly RpcConfigUrlSlot[] {
  return chainType ? slotsForChainType(chainType) : filledSlots(config);
}

export function EditRpcConfigDialog({
  config,
  chainType,
  ownRpcOnly,
  onOpenChange,
  chainName,
  onUpdate,
}: {
  /** Open while set. */
  config: OrgRpcConfigView | null;
  chainType: RpcChainType | null;
  /** Whether the config's chain uses the organization's endpoints only. */
  ownRpcOnly: boolean;
  onOpenChange: (next: boolean) => void;
  chainName: (chainId: number) => string;
  onUpdate: (configId: string, body: UpdateRpcConfigBody) => Promise<unknown>;
}): React.ReactElement {
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [prompt, setPrompt] = useState<{
    details: AutoFallbackPrompt;
    apply: () => void;
  } | null>(null);
  const [errors, setErrors] = useState<RpcFormErrors>(NO_FORM_ERRORS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(config ? editDraftFor(config) : null);
    setErrors(NO_FORM_ERRORS);
  }, [config]);

  const body = useMemo<UpdateRpcConfigBody | null>(
    () => (config && draft ? buildUpdateBody(config, draft) : null),
    [config, draft]
  );
  const nameMissing = draft !== null && draft.name.trim().length === 0;
  const canSave = Boolean(body && hasChanges(body)) && !nameMissing;

  const setUrl = (slot: RpcConfigUrlSlot, value: string): void => {
    setDraft((current) =>
      current ? { ...current, urls: { ...current.urls, [slot]: value } } : null
    );
    setErrors((current) => ({
      ...current,
      slots: { ...current.slots, [slot]: undefined },
    }));
  };

  const toggleClear = (slot: RpcConfigUrlSlot): void => {
    setDraft((current) => {
      if (!current) {
        return null;
      }
      const cleared = new Set(current.cleared);
      const urls: UrlDraft = { ...current.urls };
      if (cleared.has(slot)) {
        cleared.delete(slot);
      } else {
        cleared.add(slot);
        delete urls[slot];
      }
      return { ...current, cleared, urls };
    });
  };

  const patchDraft = (patch: Partial<EditDraft>): void =>
    setDraft((current) => (current ? { ...current, ...patch } : null));

  /** Ask first when the change leaves Auto steps without this endpoint. */
  const confirmFallback = (
    change: AutoFallbackChange,
    patch: Partial<EditDraft>
  ): void => {
    if (!config) {
      return;
    }
    setPrompt({
      details: {
        change,
        configName: config.name,
        chainName: chainName(config.chainId),
        ownRpcOnly,
      },
      apply: () => patchDraft(patch),
    });
  };

  const submit = async (): Promise<void> => {
    if (!(config && body && canSave)) {
      return;
    }
    setSaving(true);
    setErrors(NO_FORM_ERRORS);
    try {
      await onUpdate(config.id, body);
      onOpenChange(false);
    } catch (error) {
      setErrors(formErrorsFrom(error, "Could not save the changes."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog onOpenChange={onOpenChange} open={config !== null}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit {config?.name ?? "RPC endpoint"}</DialogTitle>
            <DialogDescription>
              Leave a URL empty to keep the saved one. {URL_NOTE}
            </DialogDescription>
          </DialogHeader>
          {config && draft && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <div className="flex flex-col gap-1.5">
                <span className="font-medium text-sm">Chain</span>
                <div
                  className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm"
                  data-testid="rpc-edit-chain"
                >
                  <span className="truncate">{chainName(config.chainId)}</span>
                  <ChainBadges chain={{ chainId: config.chainId, chainType }} />
                </div>
                <p className="text-muted-foreground text-xs">
                  An endpoint stays on its chain. Add a new one for another
                  chain.
                </p>
              </div>

              {config.unreadable && (
                <Notice tone="warning">
                  The saved URLs can no longer be read. Paste every URL again,
                  starting with the HTTPS primary; saving replaces them.
                </Notice>
              )}

              <NameField
                error={errors.name}
                onChange={(name) => {
                  setDraft((current) =>
                    current ? { ...current, name } : null
                  );
                  setErrors((current) => ({ ...current, name: undefined }));
                }}
                value={draft.name}
              />

              {editableSlots(config, chainType).map((slot) => {
                const saved = config.slots.includes(slot);
                return (
                  <UrlField
                    cleared={draft.cleared.has(slot)}
                    error={errors.slots[slot]}
                    key={slot}
                    onChange={(value) => setUrl(slot, value)}
                    onToggleClear={
                      saved && slot !== REQUIRED_SLOT
                        ? () => toggleClear(slot)
                        : undefined
                    }
                    placeholder={
                      saved ? SAVED_URL_PLACEHOLDER : slotPlaceholder(slot)
                    }
                    slot={slot}
                    value={draft.urls[slot] ?? ""}
                  />
                );
              })}

              <SwitchField
                checked={draft.enabled}
                label="Enabled"
                onChange={(enabled) => {
                  if (!enabled && draft.isDefault) {
                    confirmFallback(AutoFallbackChange.DISABLE_DEFAULT, {
                      enabled,
                    });
                    return;
                  }
                  patchDraft({ enabled });
                }}
              />
              <SwitchField
                checked={draft.isDefault}
                hint={DEFAULT_HINT}
                label={DEFAULT_LABEL}
                onChange={(isDefault) => {
                  if (!isDefault && config.isDefault) {
                    confirmFallback(AutoFallbackChange.UNSET_DEFAULT, {
                      isDefault,
                    });
                    return;
                  }
                  patchDraft({ isDefault });
                }}
              />

              <FormProblem chainName={chainName} errors={errors} />

              <DialogFooter>
                <Button
                  disabled={saving}
                  onClick={() => onOpenChange(false)}
                  type="button"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button disabled={!canSave || saving} type="submit">
                  {saving ? "Saving..." : "Save changes"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <AutoFallbackConfirm
        onCancel={() => setPrompt(null)}
        onConfirm={() => {
          prompt?.apply();
          setPrompt(null);
        }}
        prompt={prompt?.details ?? null}
      />
    </>
  );
}

/** Shows why a change was refused: the nodes it would have left uncovered. */
export function CoverageRefusalDialog({
  refusal,
  onOpenChange,
  chainName,
}: {
  refusal: { message: string; gaps: CoverageGap[] } | null;
  onOpenChange: (next: boolean) => void;
  chainName: (chainId: number) => string;
}): React.ReactElement {
  return (
    <Dialog onOpenChange={onOpenChange} open={refusal !== null}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Change not saved</DialogTitle>
          <DialogDescription>
            {refusal?.message} Add or enable an endpoint for these chains first,
            or change the nodes.
          </DialogDescription>
        </DialogHeader>
        {refusal && (
          <div className="max-h-96 overflow-y-auto">
            <CoverageGapList chainName={chainName} gaps={refusal.gaps} />
          </div>
        )}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
