import { useCallback, useSyncExternalStore } from 'react';
import { settingsService } from './SettingsService';

export type Locale = 'en' | 'ru';

const en = {
    // Common
    back: 'Back',
    back_home: 'Back to home',
    home: 'Home',
    loading: 'Loading...',
    error: 'Error',
    checking: 'Checking…',
    show: 'Show',
    hide: 'Hide',
    yes: 'yes',
    no: 'no',
    sign_out: 'Sign out',

    welcome_title: 'Lingua Franca',
    welcome_subtitle: 'Real-time high-quality audio interpretation for any event.',
    be_interpreter: 'Be an Interpreter',
    be_listener: 'Be a Listener',
    scan_to_join: 'Scan to join as a listener or interpreter',

    // Sign-in screens
    admin_access: 'Admin Access',
    enter_pin_to_manage: 'Enter PIN to manage channel settings',
    enter_pin: 'Enter Admin PIN',
    incorrect_pin: 'Incorrect PIN. Please try again.',
    interpreter_access: 'Interpreter access',
    interpreter_access_hint: 'Scan the interpreter QR code from the desktop admin page, or enter its six-digit code.',
    operator_sign_in: 'Operator sign-in',
    operator_sign_in_hint: 'Enter the administrator PIN to broadcast from this device.',
    code_placeholder: '6-digit code',
    pin_placeholder: 'Administrator PIN',
    continue_interpreter: 'Continue as interpreter',
    sign_in_operator: 'Sign in as operator',
    use_pin_instead: 'Operator? Sign in with your PIN',
    use_code_instead: 'I have an interpreter code',
    session_ended: 'This interpreter session has ended. Ask the operator for a new interpreter QR code.',

    // Admin
    admin_title: 'Admin Dashboard',
    languages_title: 'Language Channels',
    lang_name: 'Language Name',
    lang_desc: 'Description',
    iso_code_placeholder: 'ISO code (en, ru)',
    save: 'Save',
    cancel: 'Cancel',
    no_languages: 'No language channels yet. Add one to get started.',
    language_saved: 'Language saved.',
    language_removed: 'Language removed.',
    network_not_ready: 'Network address is not ready.',
    system_status: 'System status',
    media_engine: 'Media engine:',
    status_ready: 'ready',
    status_unavailable: 'unavailable',
    status_checking: 'checking',
    port_range_warning: 'Shared media port unavailable; using one port per listener, which limits capacity to roughly 45 phones. Restart the app to retry.',
    secure_storage_missing: 'Windows secure storage is unavailable, so API keys cannot be saved. Re-enter them after fixing the credential store.',
    certificate_label: 'Certificate:',
    certificate_trusted: 'trusted (no warning)',
    certificate_local: 'local fallback (browser warning)',
    expires: 'Expires: {date}',
    firewall_hint: 'Windows Firewall must allow TCP {https} and {listener}, and {rtc}.',
    phone_link_type: 'Link for listener phones',
    phone_link_plain: 'Plain link, no certificate warning (recommended)',
    phone_link_secure: 'Secure HTTPS link',
    phone_link_plain_hint: 'Phones open it straight away, with no warning and no internet needed. The audio is still encrypted. The Phone / Speaker switch may not work on this link.',
    phone_link_secure_hint: 'Phones show a certificate warning unless the trusted certificate below is set up.',
    listener_port_unavailable: 'The plain listener link is unavailable, so QR codes use HTTPS: {error}',
    redirecting_secure: 'Opening the secure page…',
    listener_qr_channel: 'Listener QR channel',
    detecting_network: 'detecting network',
    show_listener_qr: 'Show listener QR',
    listener_qr_title: '{channel} listener',
    interpreter_qr_title: '{channel} interpreter',
    code_label: 'Code: {code}',
    restart_app: 'Restart app',
    restart_needed: 'Restart Lingua Franca to apply the change.',
    restart_confirm: 'Restart Lingua Franca now? Every broadcast stops for a few seconds, and listeners reconnect on their own.',
    restarting: 'Restarting…',
    phone_interpreter: 'Phone interpreter',
    phone_interpreter_hint: 'Create a limited one-time link. The phone can broadcast only the selected language and cannot open admin settings. A phone cannot interrupt a channel that is already live; only this operator screen can take a channel over.',
    create_interpreter_qr: 'Create interpreter QR',
    interpreter_link_created: 'Interpreter link created. It is valid for eight hours and can be used once.',
    end_access_hint: 'Lost a phone, or shared a link too widely? This ends every interpreter session and unused code right away.',
    end_interpreter_access: 'End all interpreter access',
    interpreter_access_ended: 'All interpreter access has ended. Any phone that was broadcasting has been disconnected, and unused codes no longer work.',
    trusted_certificate: 'Trusted phone certificate',
    trusted_certificate_hint: 'Free option: create a subdomain at DuckDNS, then enter its name and token here. Lingua Franca will obtain a Let’s Encrypt certificate, point the hostname to this computer on the LAN, and renew it automatically.',
    duckdns_subdomain: 'DuckDNS subdomain',
    duckdns_token: 'DuckDNS token',
    token_saved: '(saved, leave blank to keep)',
    duckdns_token_placeholder: 'Token from duckdns.org',
    certificate_email: 'Certificate contact email',
    install_certificate: 'Install / renew free certificate',
    certificate_ready: 'Trusted certificate ready. New QR codes now use the warning-free hostname.',
    stop_trusted_certificate: 'Stop using the trusted certificate',
    certificate_reverted: 'Reverted to the local certificate. Restart the app to apply it; phones will warn again.',
    openai_translation: 'OpenAI translation',
    openai_billing_hint: 'Uses the OpenAI API, which is billed per use. A ChatGPT subscription does not include it.',
    openai_configured: 'OpenAI key saved: {state}',
    openai_key_placeholder: 'OpenAI API key',
    save_openai_key: 'Save OpenAI key',
    openai_key_saved: 'OpenAI key encrypted and saved.',
    test_openai: 'Test OpenAI',
    openai_test_passed: 'OpenAI Realtime credential test passed.',
    remove_openai_key: 'Remove OpenAI key',
    openai_key_removed: 'OpenAI key removed.',
    recording_label: 'Download original and translated recordings when a session stops',
    recording_saved: 'Recording preference saved.',
    network_adapter: 'Network adapter',
    automatic: 'Automatic',
    network_saved: 'Network saved. Restart the app to apply it.',
    phone_language: 'Default language for phones',
    phone_language_hint: 'Phones that have not picked EN or RU themselves use this.',
    phone_language_saved: 'Default phone language saved.',
    security: 'Security',
    security_hint: 'Set a new administrator PIN of 4 to 12 digits. A longer PIN is harder to guess. Changing it signs out every other operator session.',
    new_pin: 'New PIN',
    confirm_pin: 'Confirm PIN',
    pins_mismatch: 'The two PINs do not match.',
    pin_length: 'The PIN must be 4 to 12 digits.',
    pin_changed: 'PIN changed. Every other operator session has been signed out.',

    // Interpreter
    on_air: 'ON AIR',
    offline: 'Offline',
    starting: 'Starting...',
    select_mic: 'Select Microphone:',
    mute_warning: 'Your microphone is currently muted!',
    mode_human: 'Human',
    mode_ai: 'AI',
    default_input: 'System default audio input',
    system_output_input: 'System output / loopback (what this computer is playing)',
    refresh_inputs: 'Allow microphone access and refresh inputs',
    inputs_detected: 'Recording inputs found: {count}. Choose a microphone or USB interface, or use system output to capture audio playing through Windows. Press refresh after connecting a new device.',
    no_input_detected: 'No microphone or audio input was detected.',
    mic_privacy_status: 'Windows microphone privacy status:',
    broadcast_channel: 'Broadcast channel',
    interpreter_link_only: 'This interpreter link is for {channel} only.',
    openai_key_missing: 'Add an OpenAI API key in Admin settings.',
    ai_mode_hint: 'OpenAI translates the source and broadcasts one translated voice with captions on each target channel. It needs internet.',
    source_lang: 'Source language',
    target_channels: 'Target channels',
    listeners_connected: 'Listeners connected: {count}',
    start_broadcast: 'Start broadcast',
    stop_audio: 'Stop / kill audio',
    mute_source: 'Mute source',
    unmute_source: 'Unmute source',
    live_transcript: 'Live Transcript',
    listening: 'Listening…',
    first_audio_latency: 'First audio latency: {seconds} s',
    choose_channel_first: 'Choose a language channel first.',
    choose_source_target: 'Choose a source and at least one different target language.',
    openai_live: 'OpenAI translating live',
    operator_took_over: 'The operator took over {channel}.',
    broadcast_stopped: 'Your broadcast has stopped.',

    // Listener
    listener_mode: 'Listening Mode',
    select_channel: 'Select a language to listen',
    connecting: 'Connecting...',
    connected_receiving: 'Connected & Receiving',
    waiting_interpreter: 'Waiting for interpreter...',
    waiting_broadcast: 'Waiting for the broadcast to start…',
    media_restarting: 'Media engine restarting…',
    connection_error_waiting: 'Connection problem. Retrying…',
    interpreter_muted: 'Interpreter is Muted',
    audio_output: 'Audio output',
    audio_level: 'Incoming audio level',
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
    ai_active: 'AI Translation Active 🤖',
    original_text: 'Original',
};

export type TranslationKey = keyof typeof en;

// Typed against the English keys, so a missing Russian string is a compile error rather than
// an English word appearing in the middle of a Russian screen.
const ru: Record<TranslationKey, string> = {
    // Common
    back: 'Назад',
    back_home: 'На главную',
    home: 'Главная',
    loading: 'Загрузка...',
    error: 'Ошибка',
    checking: 'Проверка…',
    show: 'Показать',
    hide: 'Скрыть',
    yes: 'да',
    no: 'нет',
    sign_out: 'Выйти',

    welcome_title: 'Lingua Franca',
    welcome_subtitle: 'Высококачественный перевод аудио в реальном времени для любых мероприятий.',
    be_interpreter: 'Я - переводчик',
    be_listener: 'Слушать перевод',
    scan_to_join: 'Отсканируйте, чтобы присоединиться как слушатель или переводчик',

    // Sign-in screens
    admin_access: 'Доступ Администратора',
    enter_pin_to_manage: 'Введите PIN для управления настройками каналов',
    enter_pin: 'Введите PIN Администратора',
    incorrect_pin: 'Неверный PIN. Пожалуйста, попробуйте еще раз.',
    interpreter_access: 'Доступ переводчика',
    interpreter_access_hint: 'Отсканируйте QR-код переводчика со страницы администратора на компьютере или введите шестизначный код.',
    operator_sign_in: 'Вход оператора',
    operator_sign_in_hint: 'Введите PIN администратора, чтобы вести трансляцию с этого устройства.',
    code_placeholder: 'Шестизначный код',
    pin_placeholder: 'PIN администратора',
    continue_interpreter: 'Продолжить как переводчик',
    sign_in_operator: 'Войти как оператор',
    use_pin_instead: 'Вы оператор? Войдите с PIN-кодом',
    use_code_instead: 'У меня есть код переводчика',
    session_ended: 'Сеанс переводчика завершён. Попросите оператора создать новый QR-код переводчика.',

    // Admin
    admin_title: 'Панель Администратора',
    languages_title: 'Каналы Перевода',
    lang_name: 'Название Языка',
    lang_desc: 'Описание',
    iso_code_placeholder: 'Код ISO (en, ru)',
    save: 'Сохранить',
    cancel: 'Отмена',
    no_languages: 'Языковые каналы еще не добавлены. Добавьте один для начала работы.',
    language_saved: 'Язык сохранён.',
    language_removed: 'Язык удалён.',
    network_not_ready: 'Сетевой адрес ещё не определён.',
    system_status: 'Состояние системы',
    media_engine: 'Медиасервер:',
    status_ready: 'готов',
    status_unavailable: 'недоступен',
    status_checking: 'проверка',
    port_range_warning: 'Общий медиапорт недоступен: каждому слушателю выделяется свой порт, поэтому подключится не больше 45 телефонов. Перезапустите приложение, чтобы попробовать снова.',
    secure_storage_missing: 'Защищённое хранилище Windows недоступно, поэтому ключи API нельзя сохранить. Введите их снова, когда хранилище заработает.',
    certificate_label: 'Сертификат:',
    certificate_trusted: 'доверенный (без предупреждений)',
    certificate_local: 'локальный (браузер покажет предупреждение)',
    expires: 'Действует до: {date}',
    firewall_hint: 'Брандмауэр Windows должен разрешать TCP {https} и {listener}, а также {rtc}.',
    phone_link_type: 'Ссылка для телефонов слушателей',
    phone_link_plain: 'Обычная ссылка, без предупреждения о сертификате (рекомендуется)',
    phone_link_secure: 'Защищённая ссылка HTTPS',
    phone_link_plain_hint: 'Телефоны открывают её сразу, без предупреждений и без интернета. Звук всё равно шифруется. Переключатель «Телефон / Динамик» по этой ссылке может не работать.',
    phone_link_secure_hint: 'Телефоны покажут предупреждение о сертификате, если ниже не настроен доверенный сертификат.',
    listener_port_unavailable: 'Обычная ссылка для слушателей недоступна, поэтому QR-коды используют HTTPS: {error}',
    redirecting_secure: 'Открываем защищённую страницу…',
    listener_qr_channel: 'Канал для QR-кода слушателей',
    detecting_network: 'определяем сеть',
    show_listener_qr: 'Показать QR-код для слушателей',
    listener_qr_title: 'Слушатель: {channel}',
    interpreter_qr_title: 'Переводчик: {channel}',
    code_label: 'Код: {code}',
    restart_app: 'Перезапустить приложение',
    restart_needed: 'Перезапустите Lingua Franca, чтобы применить изменения.',
    restart_confirm: 'Перезапустить Lingua Franca сейчас? Все трансляции остановятся на несколько секунд, слушатели переподключатся сами.',
    restarting: 'Перезапуск…',
    phone_interpreter: 'Переводчик с телефона',
    phone_interpreter_hint: 'Создайте одноразовую ссылку с ограниченным доступом. Телефон сможет вести трансляцию только на выбранном языке и не сможет открыть настройки. Телефон не может прервать уже идущую трансляцию; перехватить канал может только оператор.',
    create_interpreter_qr: 'Создать QR-код переводчика',
    interpreter_link_created: 'Ссылка для переводчика создана. Она действует восемь часов и только один раз.',
    end_access_hint: 'Потеряли телефон или ссылка попала не к тем людям? Эта кнопка сразу завершает все сеансы переводчиков и отменяет неиспользованные коды.',
    end_interpreter_access: 'Завершить доступ всех переводчиков',
    interpreter_access_ended: 'Доступ всех переводчиков завершён. Телефоны, которые вели трансляцию, отключены, а неиспользованные коды больше не работают.',
    trusted_certificate: 'Доверенный сертификат для телефонов',
    trusted_certificate_hint: 'Бесплатный вариант: создайте поддомен на DuckDNS и введите здесь его имя и токен. Lingua Franca получит сертификат Let’s Encrypt, направит имя на этот компьютер в локальной сети и будет продлевать сертификат автоматически.',
    duckdns_subdomain: 'Поддомен DuckDNS',
    duckdns_token: 'Токен DuckDNS',
    token_saved: '(сохранён, оставьте пустым, чтобы не менять)',
    duckdns_token_placeholder: 'Токен с duckdns.org',
    certificate_email: 'Контактный email для сертификата',
    install_certificate: 'Установить или продлить бесплатный сертификат',
    certificate_ready: 'Доверенный сертификат готов. Новые QR-коды используют имя без предупреждений.',
    stop_trusted_certificate: 'Отключить доверенный сертификат',
    certificate_reverted: 'Включён локальный сертификат. Перезапустите приложение, чтобы применить его; телефоны снова будут показывать предупреждение.',
    openai_translation: 'Перевод OpenAI',
    openai_billing_hint: 'Используется OpenAI API с оплатой за использование. Подписка ChatGPT его не включает.',
    openai_configured: 'Ключ OpenAI сохранён: {state}',
    openai_key_placeholder: 'Ключ OpenAI API',
    save_openai_key: 'Сохранить ключ OpenAI',
    openai_key_saved: 'Ключ OpenAI зашифрован и сохранён.',
    test_openai: 'Проверить OpenAI',
    openai_test_passed: 'Проверка ключа OpenAI Realtime прошла успешно.',
    remove_openai_key: 'Удалить ключ OpenAI',
    openai_key_removed: 'Ключ OpenAI удалён.',
    recording_label: 'Скачивать оригинальную и переведённую запись после остановки',
    recording_saved: 'Настройка записи сохранена.',
    network_adapter: 'Сетевой адаптер',
    automatic: 'Автоматически',
    network_saved: 'Сеть сохранена. Перезапустите приложение, чтобы применить.',
    phone_language: 'Язык телефонов по умолчанию',
    phone_language_hint: 'Используется на телефонах, где не выбрали EN или RU вручную.',
    phone_language_saved: 'Язык телефонов по умолчанию сохранён.',
    security: 'Безопасность',
    security_hint: 'Задайте новый PIN администратора от 4 до 12 цифр. Длинный PIN сложнее угадать. После смены все остальные сеансы оператора завершатся.',
    new_pin: 'Новый PIN',
    confirm_pin: 'Повторите PIN',
    pins_mismatch: 'PIN-коды не совпадают.',
    pin_length: 'PIN должен содержать от 4 до 12 цифр.',
    pin_changed: 'PIN изменён. Все остальные сеансы оператора завершены.',

    // Interpreter
    on_air: 'В ЭФИРЕ',
    offline: 'Оффлайн',
    starting: 'Запуск...',
    select_mic: 'Выберите Микрофон:',
    mute_warning: 'Ваш микрофон выключен!',
    mode_human: 'Человек',
    mode_ai: 'ИИ',
    default_input: 'Вход по умолчанию в системе',
    system_output_input: 'Системный звук (то, что воспроизводит компьютер)',
    refresh_inputs: 'Разрешить доступ к микрофону и обновить список',
    inputs_detected: 'Найдено устройств записи: {count}. Выберите микрофон или USB-интерфейс либо системный звук, чтобы захватить то, что играет в Windows. После подключения нового устройства нажмите кнопку обновления.',
    no_input_detected: 'Микрофон или аудиовход не найден.',
    mic_privacy_status: 'Доступ к микрофону в Windows:',
    broadcast_channel: 'Канал трансляции',
    interpreter_link_only: 'Эта ссылка переводчика действует только для канала {channel}.',
    openai_key_missing: 'Добавьте ключ OpenAI API в настройках администратора.',
    ai_mode_hint: 'OpenAI переводит речь и транслирует переведённый голос с субтитрами на каждый выбранный канал. Нужен интернет.',
    source_lang: 'Исходный язык',
    target_channels: 'Каналы перевода',
    listeners_connected: 'Подключено слушателей: {count}',
    start_broadcast: 'Начать трансляцию',
    stop_audio: 'Остановить звук',
    mute_source: 'Выключить звук источника',
    unmute_source: 'Включить звук источника',
    live_transcript: 'Транскрипт в реальном времени',
    listening: 'Слушаем…',
    first_audio_latency: 'Задержка первого звука: {seconds} с',
    choose_channel_first: 'Сначала выберите языковой канал.',
    choose_source_target: 'Выберите исходный язык и хотя бы один другой язык перевода.',
    openai_live: 'OpenAI переводит в прямом эфире',
    operator_took_over: 'Оператор взял канал {channel} на себя.',
    broadcast_stopped: 'Ваша трансляция остановлена.',

    // Listener
    listener_mode: 'Режим Слушателя',
    select_channel: 'Выберите язык для прослушивания',
    connecting: 'Подключение...',
    connected_receiving: 'Подключено, звук идёт',
    waiting_interpreter: 'Ожидание переводчика...',
    waiting_broadcast: 'Ожидание начала трансляции…',
    media_restarting: 'Медиасервер перезапускается…',
    connection_error_waiting: 'Проблема со связью. Повторяем попытку…',
    interpreter_muted: 'Голос переводчика выключен',
    audio_output: 'Вывод звука',
    audio_level: 'Уровень входящего звука',
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
    ai_active: 'Активен перевод ИИ 🤖',
    original_text: 'Оригинал',
};

export const translations = { en, ru };

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
 * The server's interfaceLanguage, set in Admin as "Default language for phones", remains the
 * default for a device that has not chosen one.
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

    // `vars` fills {placeholders}, so a sentence keeps its own word order in each language.
    // Stable per locale, so components can list it as an effect or callback dependency
    // without re-running that effect on every render.
    const t = useCallback((key: TranslationKey, vars?: Record<string, string | number>): string => {
        const text = translations[locale][key] || en[key] || key;
        if (!vars) return text;
        return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
    }, [locale]);

    return { t, locale, setLocale: setDeviceLocale };
}
