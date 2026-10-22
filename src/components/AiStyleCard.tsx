import { useRef, useState } from 'react';
import { FileText, Save, Sparkles, Trash2 } from 'lucide-react';
import { AI_VOICES, LIVE_VOICES, MAX_AI_INSTRUCTIONS, MAX_AI_NOTES, settingsService, type AdminSettings, type AiEngine } from '../lib/SettingsService';
import { useTranslation } from '../lib/i18n';

const ENGINE_LABEL = { translate: 'ai_engine_translate', live: 'ai_engine_live', steady: 'ai_engine_steady' } as const;
const ENGINE_HINT = { translate: 'ai_engine_translate_hint', live: 'ai_engine_live_hint', steady: 'ai_engine_steady_hint' } as const;
const capitalise = (voice: string) => voice[0].toUpperCase() + voice.slice(1);

/**
 * How AI translation sounds: the fast interpreting model, Live voice (GPT-Live, the ChatGPT
 * app's voice) or Steady voice, plus the instructions and service notes the last two read.
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
    const steady = settings.aiEngine === 'steady';
    const live = settings.aiEngine === 'live';
    // A GPT-Live voice kept from Live voice is not one Steady voice has; it uses marin then.
    const voice = steady && !(AI_VOICES as readonly string[]).includes(settings.aiVoice) ? 'marin' : settings.aiVoice;

    const run = async (action: () => Promise<unknown>, success: string) => {
        setBusy(true); setMessage('');
        try { await action(); setMessage(success); }
        catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };

    const chooseEngine = (aiEngine: AiEngine) => void run(() => settingsService.setAiStyle({ aiEngine }), t('ai_style_saved'));

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
            {message && <p className="text-muted" role="status">{message}</p>}

            <div className="ai-engine-options" role="radiogroup" aria-label={t('ai_style_title')}>
                {(['translate', 'live', 'steady'] as const).map((engine) => (
                    <label key={engine} className={`ai-engine-option ${settings.aiEngine === engine ? 'selected' : ''}`}>
                        <input type="radio" name="ai-engine" checked={settings.aiEngine === engine} disabled={busy} onChange={() => chooseEngine(engine)} />
                        <span>
                            <strong>{t(ENGINE_LABEL[engine])}</strong>
                            <small className="text-muted">{t(ENGINE_HINT[engine])}</small>
                        </span>
                    </label>
                ))}
            </div>
            <p className="text-muted">{t('ai_engine_applies')}</p>

            {(steady || live) && (
                <div className="ai-steady-options">
                    <div>
                        <label>{t('ai_voice_label')}</label>
                        <select className="custom-select" value={voice} disabled={busy}
                            onChange={(event) => void run(() => settingsService.setAiStyle({ aiVoice: event.target.value }), t('ai_style_saved'))}>
                            {AI_VOICES.map((name, index) => (
                                <option key={name} value={name}>{capitalise(name)}{index < 2 ? ` (${t('ai_voice_recommended')})` : ''}</option>
                            ))}
                            {live && Object.entries(LIVE_VOICES).map(([name, accent]) => (
                                <option key={name} value={name}>{capitalise(name)} ({accent})</option>
                            ))}
                        </select>
                    </div>
                    {steady && <div>
                        <label>{t('ai_pace_label')}</label>
                        <select className="custom-select" value={settings.aiPace} disabled={busy}
                            onChange={(event) => void run(() => settingsService.setAiStyle({ aiPace: event.target.value as AdminSettings['aiPace'] }), t('ai_style_saved'))}>
                            <option value="faster">{t('ai_pace_faster')}</option>
                            <option value="balanced">{t('ai_pace_balanced')}</option>
                            <option value="smoother">{t('ai_pace_smoother')}</option>
                        </select>
                    </div>}
                </div>
            )}

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
