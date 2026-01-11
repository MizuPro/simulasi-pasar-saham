import random
import time

class EventManager:
    def __init__(self):
        # Configuration
        self.EVENT_CHANCE = 0.10  # 10% chance total for an event to trigger per check
        self.EVENT_DURATION_MIN = 30  # Seconds
        self.EVENT_DURATION_MAX = 60  # Seconds

        # Event Types
        self.TYPE_ARA = "ARA"           # Force Buy to ARA
        self.TYPE_BULLISH = "BULLISH"   # Trend Up
        self.TYPE_BEARISH = "BEARISH"   # Trend Down
        self.TYPE_ARB = "ARB"           # Force Sell to ARB

        # Probabilities within the 10% event window (Total must sum to 1.0)
        # User requested 2.5% each out of 100% total time.
        # Since we only roll when EVENT_CHANCE hits (10%), the weights here should be equal (25% each).
        # 10% * 25% = 2.5% global chance.
        self.event_weights = [
            (self.TYPE_ARA, 0.25),
            (self.TYPE_BULLISH, 0.25),
            (self.TYPE_BEARISH, 0.25),
            (self.TYPE_ARB, 0.25)
        ]

        # Active Events: { symbol: { 'type': TYPE, 'end_time': timestamp } }
        self.active_events = {}
        self.last_check_time = 0
        self.CHECK_INTERVAL = 10 # Check for new events every 10 seconds

    def update(self, active_symbols):
        """
        Called periodically to check if new events should trigger or old ones expire.
        """
        current_time = time.time()

        # 1. Cleanup expired events
        expired = []
        for symbol, event in self.active_events.items():
            if current_time > event['end_time']:
                expired.append(symbol)

        for symbol in expired:
            print(f"[EVENT] News Ended for {symbol}: {self.active_events[symbol]['type']}")
            del self.active_events[symbol]

        # 2. Trigger new events (only if check interval passed)
        if current_time - self.last_check_time > self.CHECK_INTERVAL:
            self.last_check_time = current_time

            for symbol in active_symbols:
                # If already has event, skip
                if symbol in self.active_events:
                    continue

                # Roll dice
                if random.random() < self.EVENT_CHANCE:
                    # Pick event type based on weights
                    event_type = self._pick_event_type()
                    duration = random.randint(self.EVENT_DURATION_MIN, self.EVENT_DURATION_MAX)

                    self.active_events[symbol] = {
                        'type': event_type,
                        'end_time': current_time + duration
                    }
                    print(f"[EVENT] 📰 BREAKING NEWS for {symbol}: Sentiment -> {event_type} (Duration: {duration}s)")

    def _pick_event_type(self):
        r = random.random()
        cumulative = 0.0
        for ev_type, weight in self.event_weights:
            cumulative += weight
            if r < cumulative:
                return ev_type
        return self.TYPE_BULLISH # Fallback

    def get_event(self, symbol):
        """
        Returns the active event type for a symbol, or None.
        """
        if symbol in self.active_events:
            return self.active_events[symbol]['type']
        return None
