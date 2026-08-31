import { useSyncExternalStore } from 'react';
import { settingsService } from './SettingsService';

export type Locale = 'en' | 'ru';

export const translations = {
    en: {
        // Common
        back: 'Back',
        home: 'Home',
        loading: 'Loading...',
        error: 'Error',

        welcome_title: 'Lingua Franca',
        welcome_subtitle: 'Real-time high-quality audio interpretation for any event.',
        be_interpreter: 'Be an Interpreter',
        be_listener: 'Be a Listener',
        scan_to_join: 'Scan to join as a listener or interpreter',

        // Admin
        admin_title: 'Admin Dashboard',
        enter_pin: 'Enter Admin PIN',
        change_pin: 'Change Admin PIN',
        enter_new_pin: 'Enter a new PIN',
        languages_title: 'Language Channels',
        add_language: 'Add Language',
        lang_name: 'Language Name',
        lang_desc: 'Description',
        delete: 'Delete',
        edit: 'Edit',
        save: 'Save',
        cancel: 'Cancel',
        active_session: 'Active Session',
        no_languages: 'No language channels yet. Add one to get started.',
        admin_access: 'Admin Access',
        enter_pin_to_manage: 'Enter PIN to manage channel settings',
        incorrect_pin: 'Incorrect PIN. Please try again.',
        default_pin: 'Default PIN',
        live_channels: 'Live Channels',
        no_channels: 'No channels defined yet.',

        // Interpreter
        interpreter_studio: 'Interpreter Studio',
        on_air: 'ON AIR',
        offline: 'Offline',
        starting: 'Starting...',
        translating_into: 'Translating into:',
        select_mic: 'Select Microphone:',
        go_live: 'Go Live',
        stop_broadcast: 'STOP BROADCAST',
        mute_mic: 'MUTE MIC',
        unmute_mic: 'UNMUTE MIC',
        listeners: 'Listeners',
        status: 'Status',
        mic_denied: 'Microphone access denied',
        mute_warning: 'Your microphone is currently muted!',

        // Listener
        listener_mode: 'Listening Mode',
        select_channel: 'Select a language to listen',
        connecting: 'Connecting...',
        connected_receiving: 'Connected & Receiving',
        waiting_interpreter: 'Waiting for interpreter...',
        interpreter_muted: 'Interpreter is Muted',
        volume: 'Volume',
        audio_output: 'Audio output',
        speaker: 'Speaker',
        earpiece: 'Phone / Earpiece',
        mute_audio: 'Mute',
        unmute_audio: 'Unmute',
        speaker_active: 'Speaker mode is active.',
        earpiece_active: 'Earpiece mode is active. Hold the phone to your ear.',
        earpiece_requested: 'Requesting the phone earpiece…',
        earpiece_fallback: 'This browser does not expose the earpiece directly. Use the phone audio/output control, or headphones for private listening.',
        connect: 'Connect to',
        disconnect: 'Disconnect',
        no_sound_hint: 'Click "Connect" to start listening to the translation.',
        channel_not_found: 'That channel is no longer available. Choose one from the list below.',
        waiting_for_speech: 'Waiting for speech…',
        ai_mode: 'AI Auto-Interpreter',
        human_mode: 'Human Interpreter',
        source_lang: 'Source Language:',
        target_langs: 'Target Languages:',
        gemini_api_key: 'Gemini API Key',
        test_translation: 'Test Translation',
        test_success: 'Translation test succeeded!',
        test_failed: 'Translation test failed: ',
        no_key_warning: 'No Gemini API Key configured. Falling back to free translation API.',
        ai_active: 'AI Translation Active 🤖',
        original_text: 'Original',
        live_transcript: 'Live Transcript',
        start_ai: 'Start AI Translation',
        stop_ai: 'Stop AI Translation',
        select_source_lang: 'Select Source Language',
        ai_translating_into: 'Translating into selected channels...',
    },
    ru: {
        // Common
        back: 'Назад',
        home: 'Главная',
        loading: 'Загрузка...',
        error: 'Ошибка',

        welcome_title: 'Lingua Franca',
        welcome_subtitle: 'Высококачественный перевод аудио в реальном времени для любых мероприятий.',
        be_interpreter: 'Я - переводчик',
        be_listener: 'Слушать перевод',
        scan_to_join: 'Отсканируйте, чтобы присоединиться как слушатель или переводчик',

        // Admin
        admin_title: 'Панель Администратора',
        enter_pin: 'Введите PIN Администратора',
        change_pin: 'Смена PIN-кода',
        enter_new_pin: 'Введите новый PIN',
        languages_title: 'Каналы Перевода',
        add_language: 'Добавить Язык',
        lang_name: 'Название Языка',
        lang_desc: 'Описание',
        delete: 'Удалить',
        edit: 'Изменить',
        save: 'Сохранить',
        cancel: 'Отмена',
        active_session: 'Активная Сессия',
        no_languages: 'Языковые каналы еще не добавлены. Добавьте один для начала работы.',
        admin_access: 'Доступ Администратора',
        enter_pin_to_manage: 'Введите PIN для управления настройками каналов',
        incorrect_pin: 'Неверный PIN. Пожалуйста, попробуйте еще раз.',
        default_pin: 'PIN по умолчанию',
        live_channels: 'Активные Каналы',
        no_channels: 'Каналы еще не созданы.',

        // Interpreter
        interpreter_studio: 'Студия Переводчика',
        on_air: 'В ЭФИРЕ',
        offline: 'Оффлайн',
        starting: 'Запуск...',
        translating_into: 'Перевод на:',
        select_mic: 'Выберите Микрофон:',
        go_live: 'Выйти в Эфир',
        stop_broadcast: 'ОСТАНОВИТЬ ЭФИР',
        mute_mic: 'ВЫКЛ ЗВУК',
        unmute_mic: 'ВКЛ ЗВУК',
        listeners: 'Слушатели',
        status: 'Статус',
        mic_denied: 'Доступ к микрофону отклонен',
        mute_warning: 'Ваш микрофон выключен!',

        // Listener
        listener_mode: 'Режим Слушателя',
        select_channel: 'Выберите язык для прослушивания',
        connecting: 'Подключение...',
        connected_receiving: 'Подключено и Получается',
        waiting_interpreter: 'Ожидание переводчика...',
        interpreter_muted: 'Голос переводчика выключен',
        volume: 'Громкость',
        audio_output: 'Вывод звука',
        speaker: 'Динамик',
        earpiece: 'Телефон / ухо',
        mute_audio: 'Без звука',
        unmute_audio: 'Включить звук',
        speaker_active: 'Включён режим громкого динамика.',
        earpiece_active: 'Включён разговорный динамик. Поднесите телефон к уху.',
        earpiece_requested: 'Включаем разговорный динамик…',
        earpiece_fallback: 'Этот браузер не даёт прямого доступа к разговорному динамику. Используйте системный выбор аудиовыхода или наушники.',
        connect: 'Подключиться к',
        disconnect: 'Отключиться',
        no_sound_hint: 'Нажмите "Подключиться", чтобы начать слушать перевод.',
        channel_not_found: 'Этот канал больше недоступен. Выберите канал из списка ниже.',
        waiting_for_speech: 'Ожидание речи…',
        ai_mode: 'Авто-переводчик ИИ',
        human_mode: 'Переводчик-человек',
        source_lang: 'Исходный язык:',
        target_langs: 'Языки перевода:',
        gemini_api_key: 'API-ключ Gemini',
        test_translation: 'Проверить перевод',
        test_success: 'Тест перевода прошел успешно!',
        test_failed: 'Тест перевода не удался: ',
        no_key_warning: 'API-ключ Gemini не настроен. Используется бесплатный API перевода.',
        ai_active: 'Активен перевод ИИ 🤖',
        original_text: 'Оригинал',
        live_transcript: 'Транскрипт в реальном времени',
        start_ai: 'Запустить перевод ИИ',
        stop_ai: 'Остановить перевод ИИ',
        select_source_lang: 'Выберите исходный язык',
        ai_translating_into: 'Перевод на выбранные каналы...',
    }
};

const LOCALE_KEY = 'lingua_franca_locale';
const LOCALES: Locale[] = ['en', 'ru'];

const readStoredLocale = (): Locale | null => {
    try {
        const saved = localStorage.getItem(LOCALE_KEY);
        return LOCALES.includes(saved as Locale) ? saved as Locale : null;
    } catch { return null; }
};

/**
 * Interface language is a per-device preference.
 *
 * It used to call setInterfaceLanguage(), which PATCHes /api/admin/settings. That endpoint
 * requires an operator session, so a listener tapping EN/RU on the home screen got a rejected
 * request and no language change -- and had it succeeded it would have switched the interface
 * for every device in the building, which is not what a listener is asking for.
 *
 * The server's interfaceLanguage remains the default for a device that has not chosen one.
 */
let currentLocale: Locale = readStoredLocale() ?? 'en';
let serverDefault: Locale = 'en';
let hasDeviceChoice = readStoredLocale() !== null;
const localeListeners = new Set<() => void>();

const applyLocale = (next: Locale) => {
    if (next === currentLocale) return;
    currentLocale = next;
    localeListeners.forEach((listener) => listener());
};

settingsService.subscribe((settings) => {
    serverDefault = settings.interfaceLanguage || 'en';
    if (!hasDeviceChoice) applyLocale(serverDefault);
});

export function setDeviceLocale(next: Locale) {
    hasDeviceChoice = true;
    try { localStorage.setItem(LOCALE_KEY, next); }
    catch { /* private browsing: the choice simply does not persist */ }
    applyLocale(next);
}

/** Drops the device override so the operator's configured default applies again. */
export function clearDeviceLocale() {
    hasDeviceChoice = false;
    try { localStorage.removeItem(LOCALE_KEY); } catch { /* nothing to clear */ }
    applyLocale(serverDefault);
}

const subscribeLocale = (onChange: () => void) => {
    localeListeners.add(onChange);
    return () => { localeListeners.delete(onChange); };
};

export function useTranslation() {
    // An external store rather than component state: the locale lives outside React and
    // several components read it at once.
    const locale = useSyncExternalStore(subscribeLocale, () => currentLocale, () => currentLocale);

    const t = (key: keyof typeof translations.en): string => {
        const group = translations[locale] as Record<string, string>;
        return group[key] || translations.en[key as keyof typeof translations.en] || key;
    };

    return { t, locale, setLocale: setDeviceLocale };
}
