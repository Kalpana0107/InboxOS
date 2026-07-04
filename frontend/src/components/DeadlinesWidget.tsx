import { useState, useEffect, useCallback } from 'react';
import { Clock, Bell, BellOff, CheckCircle2, ChevronDown, AlertTriangle, Calendar, Zap } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

interface ReminderEmail {
  subject: string;
  sender: string;
}

interface Reminder {
  id: string;
  emailId: string;
  deadline: string; // ISO UTC string
  status: 'PENDING' | 'SNOOZED' | 'CANCELLED' | 'FIRED';
  snoozeUntil: string | null;
  createdAt: string;
  email: ReminderEmail;
}

type TimeRemaining = {
  label: string;
  isOverdue: boolean;
  urgency: 'overdue' | 'critical' | 'warning' | 'safe';
  ms: number;
};

function getTimeRemaining(deadlineISO: string): TimeRemaining {
  const now = Date.now();
  const deadlineMs = new Date(deadlineISO).getTime();
  const diff = deadlineMs - now;

  if (diff <= 0) {
    return { label: 'Overdue', isOverdue: true, urgency: 'overdue', ms: diff };
  }

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let label = '';
  if (days > 0) label = `${days}d ${hours % 24}h`;
  else if (hours > 0) label = `${hours}h ${minutes % 60}m`;
  else label = `${minutes}m`;

  const urgency: TimeRemaining['urgency'] =
    diff < 60 * 60 * 1000 ? 'critical' :
    diff < 24 * 60 * 60 * 1000 ? 'warning' :
    'safe';

  return { label, isOverdue: false, urgency, ms: diff };
}

const SNOOZE_OPTIONS = [
  { label: '15 min', value: 15 },
  { label: '1 hour', value: 60 },
  { label: '4 hours', value: 240 },
  { label: '1 day', value: 1440 },
];

const urgencyConfig = {
  overdue:  { bg: 'bg-rose-500/10',    border: 'border-rose-500/25',    dot: 'bg-rose-400',    text: 'text-rose-400',    badge: 'bg-rose-500/15 text-rose-400 border-rose-500/20' },
  critical: { bg: 'bg-amber-500/10',   border: 'border-amber-500/25',   dot: 'bg-amber-400',   text: 'text-amber-400',   badge: 'bg-amber-500/15 text-amber-400 border-amber-500/20' },
  warning:  { bg: 'bg-yellow-500/8',   border: 'border-yellow-500/20',  dot: 'bg-yellow-400',  text: 'text-yellow-400',  badge: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
  safe:     { bg: 'bg-emerald-500/5',  border: 'border-white/8',        dot: 'bg-emerald-400', text: 'text-emerald-400', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
};

interface ReminderCardProps {
  reminder: Reminder;
  onSnooze: (id: string, minutes: number) => Promise<void>;
  onDone: (emailId: string, reminderId: string) => Promise<void>;
}

const ReminderCard: React.FC<ReminderCardProps> = ({ reminder, onSnooze, onDone }) => {
  const [showSnooze, setShowSnooze] = useState(false);
  const [snoozingId, setSnoozingId] = useState<number | null>(null);
  const [isDone, setIsDone] = useState(false);
  const [timeLeft, setTimeLeft] = useState<TimeRemaining>(() => getTimeRemaining(reminder.deadline));

  // Live countdown
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeLeft(getTimeRemaining(reminder.deadline));
    }, 30000);
    return () => clearInterval(interval);
  }, [reminder.deadline]);

  const cfg = urgencyConfig[timeLeft.urgency];

  const handleSnooze = async (minutes: number) => {
    setSnoozingId(minutes);
    try {
      await onSnooze(reminder.id, minutes);
    } finally {
      setSnoozingId(null);
      setShowSnooze(false);
    }
  };

  const handleDone = async () => {
    setIsDone(true);
    await onDone(reminder.emailId, reminder.id);
  };

  if (isDone) return null;

  const deadlineDate = new Date(reminder.deadline);
  const formattedDeadline = deadlineDate.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      className={`relative rounded-xl p-3.5 border transition-all duration-300 hover:shadow-lg group ${cfg.bg} ${cfg.border}`}
      id={`reminder-card-${reminder.id}`}
    >
      {/* Urgency pulse for overdue / critical */}
      {(timeLeft.urgency === 'overdue' || timeLeft.urgency === 'critical') && (
        <span className={`absolute top-3 right-3 h-2 w-2 rounded-full animate-ping ${cfg.dot} opacity-75`} />
      )}

      <div className="flex items-start gap-2.5">
        {/* Status dot */}
        <div className={`mt-0.5 h-2 w-2 rounded-full shrink-0 ${cfg.dot} ${timeLeft.isOverdue ? 'animate-pulse' : ''}`} />

        <div className="flex-1 min-w-0">
          {/* Subject */}
          <p className="text-xs font-semibold text-white leading-snug line-clamp-1 mb-1">
            {reminder.email.subject}
          </p>

          {/* Sender + Deadline */}
          <div className="flex items-center gap-1.5 text-[10px] text-gray-400 mb-2">
            <span className="truncate">{reminder.email.sender}</span>
            <span className="text-white/20">·</span>
            <Calendar size={9} className="shrink-0" />
            <span className="shrink-0">{formattedDeadline}</span>
          </div>

          {/* Status + countdown */}
          <div className="flex items-center justify-between">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${cfg.badge}`}>
              {timeLeft.isOverdue ? '⚠ OVERDUE' : `⏱ ${timeLeft.label} left`}
            </span>

            {reminder.status === 'SNOOZED' && (
              <span className="text-[9px] text-gray-500 flex items-center gap-1">
                <BellOff size={9} />
                Snoozed
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Action buttons — appear on hover */}
      <div className="flex items-center gap-1.5 mt-3 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        {/* Snooze button */}
        <div className="relative flex-1">
          <button
            id={`snooze-btn-${reminder.id}`}
            onClick={() => setShowSnooze(!showSnooze)}
            className="w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 text-[10px] font-semibold border border-white/5 transition-all"
          >
            <Bell size={10} />
            Snooze
            <ChevronDown size={9} className={`transition-transform ${showSnooze ? 'rotate-180' : ''}`} />
          </button>

          {showSnooze && (
            <div className="absolute bottom-full mb-1.5 left-0 right-0 bg-[#1a1d2e] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden">
              {SNOOZE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  id={`snooze-opt-${reminder.id}-${opt.value}`}
                  onClick={() => handleSnooze(opt.value)}
                  disabled={snoozingId === opt.value}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-medium text-gray-300 hover:bg-white/5 hover:text-white transition-all disabled:opacity-50"
                >
                  <Zap size={9} className="text-amber-400" />
                  {snoozingId === opt.value ? 'Snoozing…' : opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Mark Done */}
        <button
          id={`done-btn-${reminder.id}`}
          onClick={handleDone}
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-[10px] font-semibold border border-emerald-500/20 transition-all"
        >
          <CheckCircle2 size={10} />
          Done
        </button>
      </div>
    </div>
  );
};

// ─── Main Widget ───────────────────────────────────────────────────────────────

export const DeadlinesWidget: React.FC = () => {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  const fetchReminders = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/reminders/upcoming`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setReminders(data.reminders || []);
      setLastRefreshed(new Date());
      setError(null);
    } catch (err: any) {
      setError('Could not load reminders');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + polling every 60s
  useEffect(() => {
    fetchReminders();
    const interval = setInterval(fetchReminders, 60_000);
    return () => clearInterval(interval);
  }, [fetchReminders]);

  const handleSnooze = async (reminderId: string, durationMinutes: number) => {
    try {
      const res = await fetch(`${API_BASE}/api/reminders/${reminderId}/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ durationMinutes }),
      });
      if (!res.ok) throw new Error('Snooze failed');
      // Update local state
      setReminders((prev) =>
        prev.map((r) =>
          r.id === reminderId ? { ...r, status: 'SNOOZED' } : r
        )
      );
    } catch (err) {
      console.error('[DeadlinesWidget] Snooze error:', err);
    }
  };

  const handleDone = async (_emailId: string, reminderId: string) => {
    // Find action item is hard without ID here — cancel reminders directly
    try {
      await fetch(`${API_BASE}/api/reminders/${reminderId}/cancel`, {
        method: 'POST',
        credentials: 'include',
      });
      setReminders((prev) => prev.filter((r) => r.id !== reminderId));
    } catch (err) {
      console.error('[DeadlinesWidget] Done error:', err);
    }
  };

  const overdueCount = reminders.filter(
    (r) => new Date(r.deadline).getTime() < Date.now()
  ).length;

  return (
    <div className="space-y-3" id="deadlines-widget">
      {/* Header */}
      <div className="flex items-center justify-between px-1">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <Clock size={15} className="text-indigo-400" />
          <span>Upcoming Deadlines</span>
          {overdueCount > 0 && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-rose-500/15 text-rose-400 border border-rose-500/20 animate-pulse">
              {overdueCount} overdue
            </span>
          )}
        </h3>
        <button
          id="refresh-deadlines-btn"
          onClick={fetchReminders}
          className="text-[9px] text-gray-500 hover:text-indigo-400 transition-colors"
          title="Refresh"
        >
          ↻ refresh
        </button>
      </div>

      {/* Content */}
      <div className="glass rounded-2xl border border-white/5 overflow-hidden">
        {loading && (
          <div className="space-y-2.5 p-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 rounded-xl bg-white/5 animate-pulse" />
            ))}
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center gap-2">
            <AlertTriangle size={20} className="text-amber-400/50" />
            <p className="text-xs text-gray-500">{error}</p>
            <button
              onClick={fetchReminders}
              className="text-[10px] text-indigo-400 hover:underline"
            >
              Try again
            </button>
          </div>
        )}

        {!loading && !error && reminders.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center gap-2">
            <div className="h-10 w-10 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
              <CheckCircle2 size={18} className="text-emerald-400" />
            </div>
            <p className="text-xs font-semibold text-gray-300">No upcoming deadlines</p>
            <p className="text-[10px] text-gray-500">
              Deadlines are automatically extracted from emails
            </p>
          </div>
        )}

        {!loading && !error && reminders.length > 0 && (
          <div className="p-3 space-y-2.5 max-h-[420px] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
            {reminders.map((reminder) => (
              <ReminderCard
                key={reminder.id}
                reminder={reminder}
                onSnooze={handleSnooze}
                onDone={handleDone}
              />
            ))}
          </div>
        )}

        {/* Footer */}
        {!loading && reminders.length > 0 && (
          <div className="px-4 py-2.5 border-t border-white/5 flex items-center justify-between">
            <span className="text-[9px] text-gray-600">
              Updated {lastRefreshed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className="text-[9px] text-gray-600">
              {reminders.length} reminder{reminders.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
