import { useId } from 'react';

/**
 * The Lingua Franca mark: the original speech (violet) and the interpreted audio (green, with
 * sound bars). Same shapes as branding/logo-mark.svg, for dark backgrounds. Decorative: the
 * wordmark next to it carries the name.
 *
 * useId keeps the gradient and mask ids unique, since the header and the home screen can show
 * the mark at the same time and duplicate ids would make one copy borrow the other's mask.
 */
export default function LogoMark({ className }: { className?: string }) {
    const id = useId().replace(/:/g, '');
    const violet = `${id}-violet`;
    const green = `${id}-green`;
    const cut = `${id}-cut`;
    return (
        <svg className={className} viewBox="84 88 344 344" aria-hidden="true" focusable="false">
            <defs>
                <linearGradient id={violet} x1="100" y1="104" x2="316" y2="318" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stopColor="#a78bfa" />
                    <stop offset="1" stopColor="#7c3aed" />
                </linearGradient>
                <linearGradient id={green} x1="0" y1="196" x2="0" y2="420" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stopColor="#34d399" />
                    <stop offset="1" stopColor="#059669" />
                </linearGradient>
                <mask id={cut} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
                    <rect width="512" height="512" fill="#fff" />
                    <g fill="#000" stroke="#000" strokeWidth="28" strokeLinejoin="round">
                        <rect x="196" y="196" width="216" height="176" rx="54" />
                        <path d="M336 360 L392 420 L384 360 Z" />
                    </g>
                </mask>
            </defs>
            <g mask={`url(#${cut})`}>
                <g fill={`url(#${violet})`}>
                    <rect x="100" y="104" width="216" height="164" rx="52" />
                    <path d="M126 256 L112 318 L172 256 Z" />
                </g>
                <g fill="#fff">
                    <circle cx="150" cy="146" r="15" />
                    <circle cx="196" cy="146" r="15" />
                    <circle cx="242" cy="146" r="15" />
                </g>
            </g>
            <g fill={`url(#${green})`}>
                <rect x="196" y="196" width="216" height="176" rx="54" />
                <path d="M336 360 L392 420 L384 360 Z" />
            </g>
            <g fill="#fff">
                <rect x="239" y="262" width="18" height="44" rx="9" />
                <rect x="267" y="240" width="18" height="88" rx="9" />
                <rect x="295" y="222" width="18" height="124" rx="9" />
                <rect x="323" y="244" width="18" height="80" rx="9" />
                <rect x="351" y="264" width="18" height="40" rx="9" />
            </g>
        </svg>
    );
}
