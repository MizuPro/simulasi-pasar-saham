import requests
import json
import random
import time
import os

# Configuration
API_URL = "http://localhost:3000/api"
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "admin123"

# Bot Configuration
NUM_RETAIL_BOTS = 10
NUM_BANDAR_BOTS = 2

# Funding Configuration
RETAIL_RDN_MIN = 50_000_000      # 50 Juta
RETAIL_RDN_MAX = 100_000_000     # 100 Juta
RETAIL_SHARES_MIN = 10           # Lots
RETAIL_SHARES_MAX = 50           # Lots

BANDAR_RDN_MIN = 50_000_000_000  # 50 Miliar
BANDAR_RDN_MAX = 100_000_000_000 # 100 Miliar
BANDAR_SHARES_MIN = 5000         # Lots
BANDAR_SHARES_MAX = 20000        # Lots

class BotSetup:
    def __init__(self):
        self.admin_token = None
        self.stocks = []
        self.bots_data = []

    def login_admin(self):
        print(f"[*] Logging in as Admin ({ADMIN_USERNAME})...")
        try:
            res = requests.post(f"{API_URL}/auth/login", json={
                "username": ADMIN_USERNAME,
                "password": ADMIN_PASSWORD
            })
            if res.status_code == 200:
                self.admin_token = res.json()['token']
                print("[+] Admin login successful!")
            else:
                print(f"[-] Admin login failed: {res.text}")
                exit(1)
        except Exception as e:
            print(f"[-] Connection failed: {str(e)}")
            exit(1)

    def get_active_stocks(self):
        print("[*] Fetching active stocks...")
        headers = {"Authorization": f"Bearer {self.admin_token}"}
        res = requests.get(f"{API_URL}/stocks", headers=headers)
        if res.status_code == 200:
            all_stocks = res.json()
            self.stocks = [s for s in all_stocks if s.get('is_active', True)]
            print(f"[+] Found {len(self.stocks)} active stocks.")
        else:
            print(f"[-] Failed to fetch stocks: {res.text}")

    def create_and_fund_bot(self, role, index):
        prefix = "retail" if role == "RETAIL" else "bandar"
        username = f"bot_{prefix}_{index}"
        password = "password123" # Simple password for bots
        full_name = f"Bot {role.capitalize()} {index}"

        # 1. Register (or handle existing)
        user_id = None

        # Try to login first to see if exists
        try:
            login_res = requests.post(f"{API_URL}/auth/login", json={
                "username": username,
                "password": password
            })

            if login_res.status_code == 200:
                user_id = login_res.json()['user']['id']
                print(f"[.] User {username} already exists (ID: {user_id})")
            else:
                # Register
                reg_res = requests.post(f"{API_URL}/auth/register", json={
                    "username": username,
                    "password": password,
                    "fullName": full_name
                })
                if reg_res.status_code == 201:
                    user_id = reg_res.json()['user']['id']
                    print(f"[+] Created user {username}")
                else:
                    print(f"[-] Failed to register {username}: {reg_res.text}")
                    return None
        except Exception as e:
            print(f"[-] Error processing {username}: {e}")
            return None

        # 2. Fund RDN
        target_rdn = random.randint(RETAIL_RDN_MIN, RETAIL_RDN_MAX) if role == "RETAIL" else random.randint(BANDAR_RDN_MIN, BANDAR_RDN_MAX)

        headers = {"Authorization": f"Bearer {self.admin_token}"}

        # Adjust balance (We add the difference or just top up a fixed amount?
        # Simpler to just top up huge amount if balance is low, but let's just add target_rdn for now to ensure they have cash)
        # Note: The API adds the amount to current balance.

        # Check current balance first to avoid over-funding if running multiple times?
        # For simplicity, I'll just add funds.
        fund_res = requests.put(f"{API_URL}/admin/users/{user_id}/balance", headers=headers, json={
            "amount": target_rdn,
            "reason": "Initial Bot Funding"
        })

        if fund_res.status_code == 200:
            print(f"   [+] Funded RDN: {target_rdn:,.0f}")
        else:
            print(f"   [-] Failed to fund RDN: {fund_res.text}")

        # 3. Fund Shares (Portfolio)
        # Randomly select some stocks to own
        num_stocks_to_own = random.randint(1, len(self.stocks))
        chosen_stocks = random.sample(self.stocks, num_stocks_to_own)

        for stock in chosen_stocks:
            stock_id = stock['id']
            symbol = stock['symbol']

            lot_qty = random.randint(RETAIL_SHARES_MIN, RETAIL_SHARES_MAX) if role == "RETAIL" else random.randint(BANDAR_SHARES_MIN, BANDAR_SHARES_MAX)

            # Issue shares
            # Note: The API is PUT /admin/users/:userId/portfolio/:stockId
            # Body: { "amount": 10, "reason": "..." }

            share_res = requests.put(f"{API_URL}/admin/users/{user_id}/portfolio/{stock_id}", headers=headers, json={
                "amount": lot_qty,
                "reason": "Initial Bot Stock Grant"
            })

            if share_res.status_code == 200:
                print(f"   [+] Added {lot_qty} lots of {symbol}")
            else:
                # It might fail if max_shares is reached, which is fine, just skip
                pass

        return {
            "username": username,
            "password": password,
            "role": role,
            "id": user_id
        }

    def run(self):
        self.login_admin()
        self.get_active_stocks()

        print(f"\n[*] Setting up {NUM_RETAIL_BOTS} Retail Bots...")
        for i in range(1, NUM_RETAIL_BOTS + 1):
            bot = self.create_and_fund_bot("RETAIL", i)
            if bot:
                self.bots_data.append(bot)

        print(f"\n[*] Setting up {NUM_BANDAR_BOTS} Bandar Bots...")
        for i in range(1, NUM_BANDAR_BOTS + 1):
            bot = self.create_and_fund_bot("BANDAR", i)
            if bot:
                self.bots_data.append(bot)

        # Save to file
        with open("bot_data.json", "w") as f:
            json.dump(self.bots_data, f, indent=2)
        print("\n[+] Setup complete! Data saved to bot_data.json")

if __name__ == "__main__":
    setup = BotSetup()
    setup.run()
