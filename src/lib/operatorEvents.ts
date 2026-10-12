import { raiseAlert } from './alerts';
import { translateNow as tr } from './i18n';
import { realtimeSocket } from './realtimeSocket';

// Server pushes that only operator sessions receive, turned into alerts. Imported once by the
// app shell, so they reach the operator on whichever screen is open.

// One phone can be a phone problem; two on the same channel within two minutes is the channel.
const CANT_HEAR_THRESHOLD = 2;

realtimeSocket.on<{ channelId: string; channelName: string; count: number }>('listenerReports', ({ channelId, channelName, count }) => {
    if (count >= CANT_HEAR_THRESHOLD) raiseAlert('cant_hear', tr('alert_cant_hear', { count, channel: channelName }), { channelId });
});

realtimeSocket.on<{ level: number; spentUsd: number; budgetUsd: number }>('aiBudget', ({ level, spentUsd, budgetUsd }) => {
    const spent = `$${spentUsd.toFixed(2)}`;
    const budget = `$${budgetUsd.toFixed(2)}`;
    raiseAlert('budget', tr(level >= 100 ? 'alert_budget_spent' : 'alert_budget_80', { spent, budget }));
});
