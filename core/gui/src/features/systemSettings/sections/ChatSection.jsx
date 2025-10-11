import {
  BooleanField,
  DiffButton,
  Feedback,
  SectionContainer,
  TextField,
  computeDiff,
  prepareForm,
} from '../shared.jsx';
import { updateSystemSettings } from '../../../lib/api.js';

export default function ChatSection({ chat, setChat }) {
  if (chat.loading) {
    return <div className="text-sm text-muted">Loading chat settings…</div>;
  }

  const handleSave = async () => {
    const diff = computeDiff(chat.data, chat.form);
    if (Object.keys(diff).length === 0) {
      setChat((state) => ({ ...state, feedback: { tone: 'info', message: 'No changes to save.' } }));
      return;
    }
    setChat((state) => ({ ...state, feedback: { tone: 'info', message: 'Saving…' } }));
    try {
      const updated = await updateSystemSettings('chat', diff);
      setChat({
        loading: false,
        data: updated?.settings || {},
        defaults: updated?.defaults || chat.defaults,
        form: prepareForm(updated?.defaults || {}, updated?.settings || {}),
        feedback: { tone: 'success', message: 'Chat settings saved.' },
      });
    } catch (exc) {
      setChat((state) => ({
        ...state,
        feedback: { tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to save settings.' },
      }));
    }
  };

  return (
    <SectionContainer title="Chat settings">
      <div className="grid gap-4 md:grid-cols-2">
        {Object.entries(chat.form).map(([key, value]) => {
          if (typeof chat.defaults[key] === 'boolean' || typeof value === 'boolean') {
            return (
              <BooleanField
                key={key}
                label={key}
                value={Boolean(value)}
                onChange={(next) => setChat((state) => ({
                  ...state,
                  form: { ...state.form, [key]: next },
                }))}
              />
            );
          }
          if (typeof chat.defaults[key] === 'number' || typeof value === 'number') {
            return (
              <TextField
                key={key}
                label={key}
                type="number"
                value={value}
                onChange={(next) => setChat((state) => ({
                  ...state,
                  form: { ...state.form, [key]: Number(next) },
                }))}
              />
            );
          }
          return (
            <TextField
              key={key}
              label={key}
              value={value ?? ''}
              onChange={(next) => setChat((state) => ({
                ...state,
                form: { ...state.form, [key]: next },
              }))}
            />
          );
        })}
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        <Feedback message={chat.feedback?.message} tone={chat.feedback?.tone} />
        <DiffButton onClick={handleSave}>
          Save changes
        </DiffButton>
      </div>
    </SectionContainer>
  );
}
