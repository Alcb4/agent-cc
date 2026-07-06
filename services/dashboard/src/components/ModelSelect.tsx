"use client";

import { useState } from "react";
import { MODELS_BY_PROVIDER, ALL_MODELS, type ModelOption } from "@/lib/models";

const CUSTOM = "__custom__";

// N2: a model dropdown that prevents typos but keeps a custom escape hatch.
// `provider` scopes the list to that provider type; omit it for a cross-provider
// list (e.g. a project's default model). An empty value selects the first option.
export function ModelSelect({
  value,
  onChange,
  provider,
  allowEmpty = false,
  placeholder = "default model",
}: {
  value: string;
  onChange: (v: string) => void;
  provider?: string;
  allowEmpty?: boolean;
  placeholder?: string;
}) {
  const options: ModelOption[] = provider ? (MODELS_BY_PROVIDER[provider] ?? ALL_MODELS) : ALL_MODELS;
  const known = options.some((o) => o.id === value);
  // Custom mode when the current value isn't a known option and isn't empty.
  const [custom, setCustom] = useState(value !== "" && !known);

  if (custom) {
    return (
      <span className="model-select">
        <input
          placeholder="custom model id"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
        <button type="button" onClick={() => { setCustom(false); onChange(""); }}>
          ↩ list
        </button>
      </span>
    );
  }

  return (
    <select
      value={known ? value : ""}
      onChange={(e) => {
        if (e.target.value === CUSTOM) {
          setCustom(true);
          onChange("");
        } else {
          onChange(e.target.value);
        }
      }}
    >
      {allowEmpty && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
      <option value={CUSTOM}>Custom…</option>
    </select>
  );
}
