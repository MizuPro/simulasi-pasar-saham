import requests
import json
import time
import random
import threading
from datetime import datetime

# Configuration
API_URL = "http://localhost:3000/api"
TICK_DELAY_MIN = 0.5  # Seconds between bot actions
TICK_DELAY_MAX = 2.0

class BotAgent:
    def __init__(self, data):
        self.username = data['username']
        self.password = data['password']
        self.role = data['role']
        self.id = data['id']
        self.token = None
        self.portfolio = {} # Local cache of portfolio
        self.rdn = 0

    def login(self):
        try:
            res = requests.post(f"{API_URL}/auth/login", json={
                "username": self.username,
                "password": self.password
            })
            if res.status_code == 200:
                data = res.json()
                self.token = data['token']
                # print(f"[{self.username}] Login successful.")
                return True
            else:
                print(f"[{self.username}] Login failed: {res.text}")
                return False
        except Exception as e:
            print(f"[{self.username}] Connection error: {e}")
            return False

    def refresh_portfolio(self):
        if not self.token: return
        try:
            res = requests.get(f"{API_URL}/portfolio", headers={"Authorization": f"Bearer {self.token}"})
            if res.status_code == 200:
                data = res.json()
                self.rdn = float(data['balance_rdn'])
                self.portfolio = {s['symbol']: s for s in data['stocks']}
        except:
            pass

    def place_order(self, symbol, side, price, quantity):
        if not self.token: return

        # Basic validation to save API calls
        if side == "BUY":
            cost = price * quantity * 100
            if cost > self.rdn:
                # print(f"[{self.username}] Insufficient funds for {side} {symbol}")
                return
        elif side == "SELL":
            if symbol not in self.portfolio or self.portfolio[symbol]['quantity_owned'] < quantity:
                # print(f"[{self.username}] Not enough shares to {side} {symbol}")
                return

        try:
            payload = {
                "symbol": symbol,
                "type": side,
                "price": int(price),
                "quantity": int(quantity)
            }
            res = requests.post(f"{API_URL}/orders",
                              headers={"Authorization": f"Bearer {self.token}"},
                              json=payload)

            if res.status_code == 200:
                print(f"[{self.username}] {side} {symbol} @ {price} x {quantity} Lots - OK")
                self.refresh_portfolio() # Update balance/shares
            else:
                # print(f"[{self.username}] {side} Failed: {res.text}")
                pass
        except Exception as e:
            print(f"[{self.username}] Order Error: {e}")

class MarketSimulator:
    def __init__(self):
        self.bots = []
        self.active_stocks = []
        self.is_running = False

    def load_bots(self):
        try:
            with open("bot_data.json", "r") as f:
                bots_data = json.load(f)
                for d in bots_data:
                    bot = BotAgent(d)
                    if bot.login():
                        bot.refresh_portfolio()
                        self.bots.append(bot)
            print(f"[+] Loaded and logged in {len(self.bots)} bots.")
        except FileNotFoundError:
            print("[-] bot_data.json not found. Run bot_setup.py first.")
            exit(1)

    def update_market_data(self):
        # Admin token not needed for public stocks endpoint usually,
        # but let's assume we can hit public /stocks
        try:
            res = requests.get(f"{API_URL}/stocks")
            if res.status_code == 200:
                all_stocks = res.json()
                self.active_stocks = [s for s in all_stocks if s.get('is_active', True)]
        except:
            pass

    def get_orderbook(self, symbol):
        try:
            res = requests.get(f"{API_URL}/market/stocks/{symbol}/orderbook")
            if res.status_code == 200:
                return res.json()
        except:
            pass
        return None

    def get_tick_size(self, price):
        if price < 200: return 1
        if price < 500: return 2
        if price < 2000: return 5
        if price < 5000: return 10
        return 25

    def get_valid_price(self, price):
        tick = self.get_tick_size(price)
        return round(price / tick) * tick

    def run_strategy(self):
        self.is_running = True
        print("[*] Starting Trading Simulation... (Press Ctrl+C to stop)")

        while self.is_running:
            self.update_market_data()
            if not self.active_stocks:
                print("[-] No active stocks found. Waiting...")
                time.sleep(5)
                continue

            # Shuffle bots to make it random who acts first
            random.shuffle(self.bots)

            for bot in self.bots:
                stock = random.choice(self.active_stocks)
                symbol = stock['symbol']
                last_price = float(stock['lastPrice'])

                # Fetch orderbook for decision making
                ob = self.get_orderbook(symbol)
                if not ob: continue

                best_bid = ob['bids'][0]['price'] if ob['bids'] else last_price
                best_ask = ob['asks'][0]['price'] if ob['asks'] else last_price

                if best_ask == 0: best_ask = last_price # Handle empty asks
                if best_bid == 0: best_bid = last_price

                action_delay = random.uniform(TICK_DELAY_MIN, TICK_DELAY_MAX)

                if bot.role == "BANDAR":
                    self.execute_bandar_logic(bot, stock, ob, best_bid, best_ask)
                else:
                    self.execute_retail_logic(bot, stock, ob, best_bid, best_ask)

                # Sleep between bots to spread load
                time.sleep(action_delay / len(self.bots))

    def execute_bandar_logic(self, bot, stock, ob, best_bid, best_ask):
        # Bandar Logic: Move the market or create walls
        decision = random.random()
        symbol = stock['symbol']

        # 40% Chance: Create Support (Buy Limit below price)
        if decision < 0.4:
            tick = self.get_tick_size(best_bid)
            price = best_bid - (random.randint(1, 3) * tick)
            if price <= 0: price = tick
            qty = random.randint(1000, 5000) # Thick wall
            bot.place_order(symbol, "BUY", price, qty)

        # 20% Chance: HAKA (Eat Offer) - Push price up
        elif decision < 0.6:
            price = best_ask
            qty = random.randint(100, 500) # Eat substantial amount
            bot.place_order(symbol, "BUY", price, qty)

        # 10% Chance: HAKI (Dump) - Push price down
        elif decision < 0.7:
             # Check if has shares
            if symbol in bot.portfolio:
                price = best_bid
                qty = random.randint(100, 500)
                bot.place_order(symbol, "SELL", price, qty)

        # 30% Chance: Do nothing (observe)

    def execute_retail_logic(self, bot, stock, ob, best_bid, best_ask):
        # Retail Logic: Follow trend or noise
        symbol = stock['symbol']
        change_pct = float(stock.get('changePercent', 0))

        # Psychology
        is_fomo = change_pct > 2.0
        is_panic = change_pct < -2.0

        qty = random.randint(1, 20) # Small retail lots

        if is_fomo:
            # 80% Chance to BUY if FOMO
            if random.random() < 0.8:
                # HAKA (Market Buy)
                bot.place_order(symbol, "BUY", best_ask, qty)
                return

        if is_panic:
            # 80% Chance to SELL if Panic
            if random.random() < 0.8 and symbol in bot.portfolio:
                # HAKI (Market Sell)
                bot.place_order(symbol, "SELL", best_bid, qty)
                return

        # Normal Market Noise
        decision = random.random()

        if decision < 0.3: # 30% Buy
            # 50/50 between HAKA or Antri (Bid)
            if random.random() < 0.5:
                bot.place_order(symbol, "BUY", best_ask, qty)
            else:
                tick = self.get_tick_size(best_bid)
                price = best_bid - (random.randint(0, 2) * tick)
                if price <= 0: price = tick
                bot.place_order(symbol, "BUY", price, qty)

        elif decision < 0.6: # 30% Sell
             if symbol in bot.portfolio:
                if random.random() < 0.5:
                    bot.place_order(symbol, "SELL", best_bid, qty)
                else:
                    tick = self.get_tick_size(best_ask)
                    price = best_ask + (random.randint(0, 2) * tick)
                    bot.place_order(symbol, "SELL", price, qty)

if __name__ == "__main__":
    sim = MarketSimulator()
    sim.load_bots()
    try:
        sim.run_strategy()
    except KeyboardInterrupt:
        print("\n[*] Stopping simulation...")
