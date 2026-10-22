import { useRef, useState } from 'react';
import { FileText, Save, Sparkles, Trash2 } from 'lucide-react';
import { AI_VOICES, LIVE_VOICES, MAX_AI_INSTRUCTIONS, MAX_AI_NOTES, settingsService, type AdminSettings } from '../lib/SettingsService';
import { useTranslation } from '../lib/i18n';

const capitalise = (voice: string) => voice[0].toUpperCase() + voice.slice(1);

/**
 * The AI translator (GPT-Live): its voice, plus the instructions and service notes it reads
 * to get names, terms and Bible references right.
 */
export default function AiStyleCard({ settings }: { settings: AdminSettings }) {
    const { t } = useTranslation();
    // Drafts until saved, so a settings push does not wipe what is being typed.
    const [instructionsDraft, setInstructionsDraft] = useState<string | null>(null);
    const [notesDraft, setNotesDraft] = useState<string | null>(null);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

    const instructions = instructionsDraft ?? settings.aiInstructions;
    const notes = notesDraft ?? settings.aiNotes;

    const run = async (action: () => Promise<unknown>, success: string) => {
        setBusy(true); setMessage('');
        try { await action(); setMessage(success); }
        catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };

    const loadFile = (file: File | undefined) => {
        if (!file) return;
        void run(async () => {
            const text = await settingsService.extractNotes(file);
            // Added below what is already there, so several files can go in one after another.
            setNotesDraft((previous) => [(previous ?? settings.aiNotes).trim(), `[${file.name}]\n${text}`].filter(Boolean).join('\n\n'));
        }, t('ai_notes_loaded', { name: file.name }));
        if (fileInput.current) fileInput.current.value = '';
    };

    const saveText = () => void run(async () => {
        await settingsService.setAiStyle({ aiInstructions: instructions, aiNotes: notes });
        setInstructionsDraft(null); setNotesDraft(null);
    }, t('ai_notes_saved'));

    const unsaved = instructionsDraft !== null || notesDraft !== null;

    return (
        <div className="card fade-in">
            <div className="card-header"><Sparkles size={20} /><h3>{t('ai_style_title')}</h3></div>
            <p className="text-muted">{t('ai_style_hint')}</p>
            {message && <p className="text-muted" role="status">{message}</p>}

            <label htmlFor="ai-voice">{t('ai_voice_label')}</label>
            <select id="ai-voice" className="custom-select" value={settings.aiVoice} disabled={busy}
                onChange={(event) => void run(() => settingsService.setAiStyle({ aiVoice: event.target.value }), t('ai_style_saved'))}>
                {AI_VOICES.map((name, index) => (
                    <option key={name} value={name}>{capitalise(name)}{index < 2 ? ` (${t('ai_voice_recommended')})` : ''}</option>
                ))}
                {Object.entries(LIVE_VOICES).map(([name, accent]) => (
                    <option key={name} value={name}>{capitalise(name)} ({accent})</option>
                ))}
            </select>

            <label className="mt-4" htmlFor="ai-instructions">{t('ai_instructions_label')}</label>
            <textarea id="ai-instructions" className="custom-input" rows={4} maxLength={MAX_AI_INSTRUCTIONS}
                placeholder={t('ai_instructions_placeholder')} value={instructions} onChange={(event) => setInstructionsDraft(event.target.value)} />

            <label className="mt-4" htmlFor="ai-notes">{t('ai_notes_label')}</label>
            <p className="text-muted">{t('ai_notes_hint')}</p>
            <textarea id="ai-notes" className="custom-input" rows={8} placeholder={t('ai_notes_placeholder')}
                value={notes} onChange={(event) => setNotesDraft(event.target.value)} />
            <p className={`text-muted ai-notes-count ${notes.length > MAX_AI_NOTES ? 'over' : ''}`}>
                {notes.length > MAX_AI_NOTES
                    ? t('ai_notes_too_long', { count: notes.length.toLocaleString(), max: MAX_AI_NOTES.toLocaleString() })
                    : t('ai_notes_count', { count: notes.length.toLocaleString(), max: MAX_AI_NOTES.toLocaleString() })}
            </p>

            <input ref={fileInput} type="file" hidden accept=".pptx,.docx,.txt,.md" onChange={(event) => loadFile(event.target.files?.[0])} />
            <div className="ai-notes-actions">
                <button className="btn-secondary" disabled={busy} onClick={() => fileInput.current?.click()}><FileText size={18} /> {t('ai_notes_load')}</button>
                <button className="btn-primary" disabled={busy || !unsaved} onClick={saveText}><Save size={18} /> {t('save')}</button>
                <button className="btn-secondary" disabled={busy || (!notes && !settings.aiNotes)} onClick={() => {
                    if (!window.confirm(t('ai_notes_clear_confirm'))) return;
                    void run(async () => { await settingsService.setAiStyle({ aiNotes: '' }); setNotesDraft(null); }, t('ai_notes_cleared'));
                }}><Trash2 size={18} /> {t('ai_notes_clear')}</button>
            </div>
        </div>
    );
}
