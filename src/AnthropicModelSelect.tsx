import { useId } from 'react';
import { ANTHROPIC_MODELS, isAnthropicModelId } from './anthropic-models';
import './anthropic-model-select.css';

interface Props {
  label: string;
  value: string;
  defaultModel?: string;
  disabled?: boolean;
  onChange: (model: string) => void;
}

export function AnthropicModelSelect({ label, value, defaultModel, disabled, onChange }: Props) {
  const id = useId();
  const customDefault = defaultModel && !isAnthropicModelId(defaultModel) ? defaultModel : null;
  return <label className="anthropic-model-select" htmlFor={id}>
    <span>{label}</span>
    <select id={id} aria-label={label} value={value} disabled={disabled} onChange={event => {
      const model = event.currentTarget.value;
      if (isAnthropicModelId(model) || model === customDefault) onChange(model);
    }}>
      {ANTHROPIC_MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
      {customDefault && <option value={customDefault}>{customDefault} · server default</option>}
    </select>
  </label>;
}
