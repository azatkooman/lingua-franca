import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, MessageCircle, Monitor, Moon, Phone, Send, Sun } from 'lucide-react';
import LogoMark from './LogoMark';
import { settingsService, type ContactInfo } from '../lib/SettingsService';
import { LOCALES, useTranslation } from '../lib/i18n';
import { cycleTheme, useTheme } from '../lib/theme';

const digits = (value: string) => value.replace(/\D/g, '');

// Links are built here from cleaned values (the server keeps only digits, +, spaces and
// brackets in numbers), never taken from the settings as URLs.
function contactLinks(contact: ContactInfo) {
    const links: { key: string; href: string; label: string; icon: typeof Phone; external?: boolean }[] = [];
    // Keep a leading + only when the organiser wrote one: "8 701 …" is a local number, and
    // forcing + onto it would dial a different country.
    const dial = (value: string) => `${value.trim().startsWith('+') ? '+' : ''}${digits(value)}`;
    if (contact.phone) links.push({ key: 'phone', href: `tel:${dial(contact.phone)}`, label: contact.phone, icon: Phone });
    if (contact.whatsapp) links.push({ key: 'whatsapp', href: `https://wa.me/${digits(contact.whatsapp)}`, label: 'WhatsApp', icon: MessageCircle, external: true });
    if (contact.telegram) {
        const handle = contact.telegram.replace(/^@/, '');
        const target = /^\+?\d{5,}$/.test(handle) ? `+${digits(handle)}` : handle;
        links.push({ key: 'telegram', href: `https://t.me/${target}`, label: 'Telegram', icon: Send, external: true });
    }
    if (contact.email) links.push({ key: 'email', href: `mailto:${contact.email}`, label: contact.email, icon: Mail });
    return links;
}

function ContactButton() {
    const { t } = useTranslation();
    const [contact, setContact] = useState<ContactInfo | undefined>(settingsService.getSettings().contact);
    const [open, setOpen] = useState(false);
    const wrapper = useRef<HTMLDivElement>(null);

    useEffect(() => settingsService.subscribe((settings) => setContact(settings.contact)), []);

    // Close on a tap outside or on Escape, like any menu.
    useEffect(() => {
        if (!open) return;
        const onPointer = (event: PointerEvent) => {
            if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('pointerdown', onPointer);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onPointer);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const links = contact ? contactLinks(contact) : [];
    if (!links.length) return null;

    return (
        <div className="contact-wrapper" ref={wrapper}>
            <button type="button" className="header-icon-btn" aria-label={t('contact_us')} title={t('contact_us')}
                aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}>
                <Phone size={18} />
            </button>
            {open && (
                <div className="contact-popover" role="dialog" aria-label={t('contacts_title')}>
                    <p className="contact-popover-title">{t('contacts_title')}</p>
                    <p className="contact-popover-hint">{t('contacts_hint')}</p>
                    {contact?.name && <p className="contact-popover-name">{contact.name}</p>}
                    <ul>
                        {links.map(({ key, href, label, icon: Icon, external }) => (
                            <li key={key}>
                                <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                                    <Icon size={16} /> <span>{label}</span>
                                </a>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

function LanguageSwitch() {
    const { t, locale, setLocale } = useTranslation();
    return (
        <div className="lang-switch" role="group" aria-label={t('interface_language')}>
            {LOCALES.map((option) => (
                <button key={option.code} type="button" lang={option.code} aria-label={option.name}
                    aria-pressed={locale === option.code} className={locale === option.code ? 'active' : ''}
                    onClick={() => setLocale(option.code)}>
                    {option.label}
                </button>
            ))}
        </div>
    );
}

function ThemeToggle() {
    const { t } = useTranslation();
    const { preference } = useTheme();
    const Icon = preference === 'light' ? Sun : preference === 'dark' ? Moon : Monitor;
    const label = t(preference === 'light' ? 'theme_light' : preference === 'dark' ? 'theme_dark' : 'theme_system');
    return (
        <button type="button" className="header-icon-btn" onClick={cycleTheme} aria-label={label} title={label}>
            <Icon size={18} />
        </button>
    );
}

export default function AppHeader() {
    const { t } = useTranslation();
    return (
        <header className="app-header">
            <Link to="/" className="logo-container" aria-label={t('home')}>
                <LogoMark className="logo-icon" />
                <h1>Lingua<span className="logo-accent">Franca</span></h1>
            </Link>
            <div className="header-actions">
                <ContactButton />
                <LanguageSwitch />
                <ThemeToggle />
            </div>
        </header>
    );
}
