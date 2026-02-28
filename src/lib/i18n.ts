import { useState, useEffect } from 'react';
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
        connect: 'Connect to',
        disconnect: 'Disconnect',
        no_sound_hint: 'Click "Connect" to start listening to the translation.',
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
        connect: 'Подключиться к',
        disconnect: 'Отключиться',
        no_sound_hint: 'Нажмите "Подключиться", чтобы начать слушать перевод.',
    }
};

export function useTranslation() {
    const [locale, setLocale] = useState<Locale>('en');

    useEffect(() => {
        const unsubscribe = settingsService.subscribe(s => {
            setLocale(s.interfaceLanguage || 'en');
        });
        return unsubscribe;
    }, []);

    const t = (key: keyof typeof translations.en): string => {
        const group = translations[locale] as Record<string, string>;
        return group[key] || translations.en[key as keyof typeof translations.en] || key;
    };

    return { t, locale, setLocale: (l: Locale) => settingsService.setInterfaceLanguage(l) };
}
