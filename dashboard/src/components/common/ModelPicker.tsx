import { useState } from 'react';

type ModelPickerProps = {
  value: string;
  models: string[];
  onChange: (value: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  placeholder?: string;
};

export default function ModelPicker({ value, models, onChange, allowEmpty = false, emptyLabel = '继承主模型', placeholder = '选择模型' }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredModels = models.filter(model => model.toLowerCase().includes(normalizedQuery));
  const displayValue = open ? query : value;
  const disabled = models.length === 0 && !allowEmpty;

  const choose = (model: string) => {
    onChange(model);
    setQuery('');
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={displayValue}
        onFocus={() => {
          setOpen(true);
          setQuery('');
        }}
        onChange={event => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={event => {
          if (event.key === 'Enter' && open) {
            event.preventDefault();
            const first = filteredModels[0] || (allowEmpty && !query.trim() ? '' : undefined);
            if (first !== undefined) choose(first);
          }
          if (event.key === 'Escape') setOpen(false);
        }}
        placeholder={models.length || allowEmpty ? placeholder : '先到账户管理配置可用模型'}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        style={{ fontFamily: 'var(--font-mono)', paddingRight: 34 }}
      />
      <button
        type="button"
        className="btn btn-sm"
        onMouseDown={event => event.preventDefault()}
        onClick={() => {
          if (!disabled) {
            setOpen(current => !current);
            setQuery('');
          }
        }}
        disabled={disabled}
        aria-label="展开模型列表"
        style={{ position: 'absolute', right: 5, top: 5, width: 26, height: 26, padding: 0 }}
      >
        ▾
      </button>
      {open && !disabled && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            zIndex: 120,
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            maxHeight: 220,
            overflowY: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'var(--bg-card)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, .18)',
          }}
        >
          {allowEmpty && !normalizedQuery && (
            <button
              type="button"
              role="option"
              className="btn btn-sm"
              onMouseDown={event => event.preventDefault()}
              onClick={() => choose('')}
              style={{ width: '100%', justifyContent: 'flex-start', border: 0, borderRadius: 0 }}
            >
              {emptyLabel}
            </button>
          )}
          {filteredModels.map(model => (
            <button
              type="button"
              role="option"
              aria-selected={model === value}
              key={model}
              className="btn btn-sm"
              onMouseDown={event => event.preventDefault()}
              onClick={() => choose(model)}
              style={{
                width: '100%',
                justifyContent: 'flex-start',
                border: 0,
                borderRadius: 0,
                fontFamily: 'var(--font-mono)',
                background: model === value ? 'var(--accent-bg)' : 'transparent',
              }}
            >
              {model}
            </button>
          ))}
          {filteredModels.length === 0 && (
            <div style={{ padding: '8px 10px', color: 'var(--ink-muted)', fontSize: '.78em' }}>
              没有匹配的可用模型
            </div>
          )}
        </div>
      )}
    </div>
  );
}
