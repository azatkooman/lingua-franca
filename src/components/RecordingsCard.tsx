import { useCallback, useEffect, useState } from 'react';
import { AudioLines, Circle, Download, FileText, FolderOpen, Trash2 } from 'lucide-react';
import { settingsService, type AdminSettings, type RecordingItem } from '../lib/SettingsService';
import { formatDuration, formatEventDates, intlLocale, useTranslation, type TranslationKey } from '../lib/i18n';

const REFRESH_MS = 10_000;
const ROLE_LABEL: Record<NonNullable<RecordingItem['role']>, TranslationKey> = {
    original: 'role_original',
    translation: 'role_translation',
    interpreter: 'role_interpreter',
};
const isDesktopApp = () => /\bElectron\//i.test(navigator.userAgent);

/** Recording switches, and every saved recording and transcript to download or delete. */
export default function RecordingsCard({ settings }: { settings: AdminSettings }) {
    const { t, locale } = useTranslation();
    const [items, setItems] = useState<RecordingItem[] | null>(null);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState('');

    const refresh = useCallback(async () => {
        try { setItems((await settingsService.listRecordings()).items); }
        catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    }, []);

    useEffect(() => {
        const first = window.setTimeout(() => void refresh(), 0);
        const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, REFRESH_MS);
        return () => { window.clearTimeout(first); window.clearInterval(timer); };
    }, [refresh]);

    const act = async (key: string, action: () => Promise<unknown>, success = '') => {
        setBusy(key); setMessage('');
        try { await action(); if (success) setMessage(success); }
        catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(''); void refresh(); }
    };

    const download = (item: RecordingItem) => act(item.name, async () => {
        const blob = await settingsService.downloadRecording(item.name);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = item.name;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });

    const remove = (item: RecordingItem) => {
        if (!window.confirm(t('delete_confirm', { name: item.name }))) return;
        void act(item.name, () => settingsService.deleteRecording(item.name), t('deleted'));
    };

    const intl = intlLocale(locale);
    const size = (bytes: number) => bytes < 1024 * 1024
        ? `${Math.max(1, Math.round(bytes / 1024))} KB`
        : `${new Intl.NumberFormat(intl, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
    const time = (iso: string) => iso ? new Date(iso).toLocaleTimeString(intl, { hour: '2-digit', minute: '2-digit' }) : '';
    // The app's own date format: browsers print Kazakh dates poorly.
    const day = (iso: string) => {
        const date = new Date(iso);
        return formatEventDates(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, '', locale);
    };

    // Grouped by day, newest first, which is how people look for "Sunday's recordings".
    const groups = new Map<string, RecordingItem[]>();
    for (const item of items ?? []) {
        const key = day(item.startedAt);
        groups.set(key, [...(groups.get(key) ?? []), item]);
    }

    return (
        <div className="card fade-in">
            <div className="card-header"><AudioLines size={20} /><h3>{t('recordings_title')}</h3></div>
            <p className="text-muted card-hint">{t('recordings_hint')}</p>

            <label className="checkbox-row">
                <input type="checkbox" checked={settings.recordingEnabled} disabled={busy === 'audio-switch'}
                    onChange={(event) => void act('audio-switch', () => settingsService.setRecordingEnabled(event.target.checked), t('recording_saved'))} />
                <span>{t('recording_label')}</span>
            </label>
            <p className="text-muted checkbox-hint">{t('record_audio_hint')}</p>
            <label className="checkbox-row">
                <input type="checkbox" checked={settings.transcriptsEnabled} disabled={busy === 'text-switch'}
                    onChange={(event) => void act('text-switch', () => settingsService.setTranscriptsEnabled(event.target.checked), t('recording_saved'))} />
                <span>{t('record_transcripts_label')}</span>
            </label>
            <p className="text-muted checkbox-hint">{t('record_transcripts_hint')}</p>

            {message && <p className="recordings-message">{message}</p>}

            {items !== null && items.length === 0 && <p className="text-muted">{t('recordings_empty')}</p>}
            {[...groups].map(([date, entries]) => (
                <section key={date} className="recordings-day">
                    <h4>{date}</h4>
                    <ul className="recordings-list">
                        {entries.map((item) => (
                            <li key={item.name} className="recording-item">
                                <span className="recording-icon" aria-hidden="true">{item.type === 'audio' ? <AudioLines size={18} /> : <FileText size={18} />}</span>
                                <div className="recording-text">
                                    <strong>
                                        {item.channelName} · {item.type === 'audio' ? t(ROLE_LABEL[item.role ?? 'interpreter']) : t('transcript_label')}
                                    </strong>
                                    <span className="text-muted">
                                        {item.type === 'audio'
                                            ? [`${time(item.startedAt)}${item.endedAt ? `–${time(item.endedAt)}` : ''}`,
                                                item.durationMs ? formatDuration(item.durationMs / 1000, locale) : '', size(item.size)].filter(Boolean).join(' · ')
                                            : [t('transcript_lines', { count: item.lines ?? 0 }), size(item.size)].join(' · ')}
                                    </span>
                                    {item.active && <span className="rec-badge"><Circle size={8} fill="currentColor" /> {t('recording_in_progress')}</span>}
                                </div>
                                <div className="recording-actions">
                                    <button type="button" className="btn-icon-small" disabled={busy === item.name} onClick={() => void download(item)}
                                        title={t('download')} aria-label={`${t('download')}: ${item.name}`}><Download size={16} /></button>
                                    <button type="button" className="btn-icon-small danger" disabled={busy === item.name || item.active} onClick={() => remove(item)}
                                        title={t('delete')} aria-label={`${t('delete')}: ${item.name}`}><Trash2 size={16} /></button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            ))}

            {isDesktopApp() && (
                <button type="button" className="btn-secondary mt-4" disabled={busy === 'folder'}
                    onClick={() => void act('folder', () => settingsService.openRecordingsFolder())}>
                    <FolderOpen size={18} /> {t('open_folder')}
                </button>
            )}
        </div>
    );
}
