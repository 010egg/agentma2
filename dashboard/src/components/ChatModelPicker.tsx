type ChatModelPickerProps = {
  value: string;
  templateModel?: string;
  models: string[];
  disabled?: boolean;
  onChange: (model: string) => void;
};

function uniqueModels(models: string[], value: string, templateModel: string) {
  const next = new Set<string>();
  for (const model of [value, templateModel, ...models]) {
    const normalized = model.trim();
    if (normalized) next.add(normalized);
  }
  return Array.from(next);
}

export default function ChatModelPicker({ value, templateModel = '', models, disabled = false, onChange }: ChatModelPickerProps) {
  const normalizedValue = value.trim();
  const normalizedTemplateModel = templateModel.trim();
  const options = uniqueModels(models, normalizedValue, normalizedTemplateModel);
  const hasOverride = Boolean(normalizedValue && normalizedTemplateModel && normalizedValue !== normalizedTemplateModel);

  return (
    <span className="chat-model-picker" title={hasOverride ? `当前会话覆盖 Agent 模板模型：${normalizedTemplateModel}` : '当前对话模型'}>
      <span className="chat-model-picker-label">模型</span>
      <select
        aria-label="选择对话模型"
        value={normalizedValue}
        onChange={event => onChange(event.target.value)}
        disabled={disabled || options.length === 0 || (Boolean(normalizedValue) && options.length <= 1)}
      >
        {options.length === 0 ? (
          <option value="">未配置模型</option>
        ) : (
          <>
            {!normalizedValue && <option value="">选择模型</option>}
            {options.map(model => (
              <option key={model} value={model}>
                {model === normalizedTemplateModel ? `${model} · 模板默认` : model}
              </option>
            ))}
          </>
        )}
      </select>
    </span>
  );
}
