create table public.candles (
                                tableoid oid not null,
                                cmax cid not null,
                                xmax xid not null,
                                cmin cid not null,
                                xmin xid not null,
                                ctid tid not null,
                                id integer primary key not null default nextval('candles_id_seq'::regclass),
                                stock_id integer,
                                timeframe character varying(10) not null,
                                open_price numeric(10,2) not null,
                                high_price numeric(10,2) not null,
                                low_price numeric(10,2) not null,
                                close_price numeric(10,2) not null,
                                volume bigint default 0,
                                timestamp timestamp without time zone not null,
                                created_at timestamp without time zone default CURRENT_TIMESTAMP,
                                session_id integer,
                                foreign key (session_id) references public.trading_sessions (id)
                                    match simple on update no action on delete set null,
                                foreign key (stock_id) references public.stocks (id)
                                    match simple on update no action on delete cascade
);
create unique index candles_stock_id_timeframe_timestamp_key on candles using btree (stock_id, timeframe, timestamp);
create index idx_candles_stock_timeframe on candles using btree (stock_id, timeframe, timestamp);
create index idx_candles_multi_timeframe on candles using btree (stock_id, timeframe, timestamp);
create index idx_candles_session on candles using btree (session_id);

create table public.daily_stock_data (
                                         tableoid oid not null,
                                         cmax cid not null,
                                         xmax xid not null,
                                         cmin cid not null,
                                         xmin xid not null,
                                         ctid tid not null,
                                         id integer primary key not null default nextval('daily_stock_data_id_seq'::regclass),
                                         session_id integer,
                                         stock_id integer,
                                         prev_close numeric(19,4) not null,
                                         open_price numeric(19,4),
                                         high_price numeric(19,4),
                                         low_price numeric(19,4),
                                         close_price numeric(19,4),
                                         ara_limit numeric(19,4) not null,
                                         arb_limit numeric(19,4) not null,
                                         volume bigint default 0,
                                         foreign key (session_id) references public.trading_sessions (id)
                                             match simple on update no action on delete cascade,
                                         foreign key (stock_id) references public.stocks (id)
                                             match simple on update no action on delete cascade
);
create unique index daily_stock_data_session_id_stock_id_key on daily_stock_data using btree (session_id, stock_id);
create index idx_daily_stock_session on daily_stock_data using btree (session_id, stock_id);

create table public.dividend_allocations (
                                             tableoid oid not null,
                                             cmax cid not null,
                                             xmax xid not null,
                                             cmin cid not null,
                                             xmin xid not null,
                                             ctid tid not null,
                                             id uuid primary key not null default gen_random_uuid(),
                                             dividend_id uuid not null,
                                             user_id uuid not null,
                                             quantity_owned integer not null,
                                             amount numeric(19,4) not null,
                                             created_at timestamp without time zone default CURRENT_TIMESTAMP,
                                             foreign key (dividend_id) references public.dividends (id)
                                                 match simple on update no action on delete no action,
                                             foreign key (user_id) references public.users (id)
                                                 match simple on update no action on delete no action
);
create index idx_dividend_allocations_user_id on dividend_allocations using btree (user_id);

create table public.dividends (
                                  tableoid oid not null,
                                  cmax cid not null,
                                  xmax xid not null,
                                  cmin cid not null,
                                  xmin xid not null,
                                  ctid tid not null,
                                  id uuid primary key not null default gen_random_uuid(),
                                  stock_id integer not null,
                                  session_id integer,
                                  dividend_per_share numeric(19,4) not null,
                                  total_payout numeric(19,4) not null,
                                  distributed_at timestamp without time zone default CURRENT_TIMESTAMP,
                                  foreign key (session_id) references public.trading_sessions (id)
                                      match simple on update no action on delete no action,
                                  foreign key (stock_id) references public.stocks (id)
                                      match simple on update no action on delete no action
);

create table public.ipo_subscriptions (
                                          tableoid oid not null,
                                          cmax cid not null,
                                          xmax xid not null,
                                          cmin cid not null,
                                          xmin xid not null,
                                          ctid tid not null,
                                          id uuid primary key not null default gen_random_uuid(),
                                          ipo_id uuid not null,
                                          user_id uuid not null,
                                          quantity integer not null,
                                          status character varying(20) default 'PENDING',
                                          created_at timestamp without time zone default CURRENT_TIMESTAMP,
                                          foreign key (ipo_id) references public.ipos (id)
                                              match simple on update no action on delete no action,
                                          foreign key (user_id) references public.users (id)
                                              match simple on update no action on delete no action
);
create unique index ipo_subscriptions_ipo_id_user_id_key on ipo_subscriptions using btree (ipo_id, user_id);
create index idx_ipo_subscriptions_user_id on ipo_subscriptions using btree (user_id);

create table public.ipos (
                             tableoid oid not null,
                             cmax cid not null,
                             xmax xid not null,
                             cmin cid not null,
                             xmin xid not null,
                             ctid tid not null,
                             id uuid primary key not null default gen_random_uuid(),
                             stock_id integer not null,
                             total_shares bigint not null,
                             offering_price numeric(19,4) not null,
                             listing_session_id integer,
                             start_offering_session_id integer,
                             end_offering_session_id integer,
                             status character varying(20) default 'PENDING',
                             created_at timestamp without time zone default CURRENT_TIMESTAMP,
                             foreign key (stock_id) references public.stocks (id)
                                 match simple on update no action on delete no action,
                             foreign key (stock_id) references public.stocks (id)
                                 match simple on update no action on delete no action
);
create index idx_ipos_stock_id on ipos using btree (stock_id);

create table public.orders (
                               tableoid oid not null,
                               cmax cid not null,
                               xmax xid not null,
                               cmin cid not null,
                               xmin xid not null,
                               ctid tid not null,
                               id uuid primary key not null default gen_random_uuid(),
                               user_id uuid,
                               stock_id integer,
                               session_id integer,
                               type character varying(10) not null,
                               price numeric(19,4) not null,
                               quantity integer not null,
                               remaining_quantity integer not null,
                               status character varying(20) default 'PENDING',
                               created_at timestamp without time zone default CURRENT_TIMESTAMP,
                               updated_at timestamp without time zone default CURRENT_TIMESTAMP,
                               avg_price_at_order numeric(19,4),
                               foreign key (session_id) references public.trading_sessions (id)
                                   match simple on update no action on delete no action,
                               foreign key (stock_id) references public.stocks (id)
                                   match simple on update no action on delete no action,
                               foreign key (user_id) references public.users (id)
                                   match simple on update no action on delete no action
);
create index idx_orders_status_stock on orders using btree (status, stock_id, price);
create index idx_orders_user_id on orders using btree (user_id);
create index idx_orders_stock_id on orders using btree (stock_id);
create index idx_orders_status on orders using btree (status);

create table public.portfolios (
                                   tableoid oid not null,
                                   cmax cid not null,
                                   xmax xid not null,
                                   cmin cid not null,
                                   xmin xid not null,
                                   ctid tid not null,
                                   user_id uuid not null,
                                   stock_id integer not null,
                                   quantity_owned integer default 0,
                                   avg_buy_price numeric(19,4) default 0,
                                   primary key (user_id, stock_id),
                                   foreign key (stock_id) references public.stocks (id)
                                       match simple on update no action on delete no action,
                                   foreign key (user_id) references public.users (id)
                                       match simple on update no action on delete no action
);
create index idx_portfolios_user_id on portfolios using btree (user_id);

create table public.stock_candles (
                                      tableoid oid not null,
                                      cmax cid not null,
                                      xmax xid not null,
                                      cmin cid not null,
                                      xmin xid not null,
                                      ctid tid not null,
                                      id integer primary key not null default nextval('stock_candles_id_seq'::regclass),
                                      stock_id integer not null,
                                      resolution character varying(5) default '1M',
                                      open_price numeric(15,2) not null,
                                      high_price numeric(15,2) not null,
                                      low_price numeric(15,2) not null,
                                      close_price numeric(15,2) not null,
                                      volume integer not null,
                                      start_time timestamp without time zone not null,
                                      created_at timestamp without time zone default now(),
                                      session_id integer,
                                      foreign key (session_id) references public.trading_sessions (id)
                                          match simple on update no action on delete set null,
                                      foreign key (stock_id) references public.stocks (id)
                                          match simple on update no action on delete no action
);
create index idx_candles_stock_time on stock_candles using btree (stock_id, start_time);
create index idx_stock_candles_session on stock_candles using btree (session_id);

create table public.stocks (
                               tableoid oid not null,
                               cmax cid not null,
                               xmax xid not null,
                               cmin cid not null,
                               xmin xid not null,
                               ctid tid not null,
                               id integer primary key not null default nextval('stocks_id_seq'::regclass),
                               symbol character varying(10) not null,
                               name character varying(100) not null,
                               is_active boolean default true,
                               max_shares bigint default 0,
                               total_shares_sold bigint default 0
);
create unique index stocks_symbol_key on stocks using btree (symbol);

create table public.trades (
                               tableoid oid not null,
                               cmax cid not null,
                               xmax xid not null,
                               cmin cid not null,
                               xmin xid not null,
                               ctid tid not null,
                               id uuid primary key not null default gen_random_uuid(),
                               buy_order_id uuid,
                               sell_order_id uuid,
                               price numeric(19,4) not null,
                               quantity integer not null,
                               executed_at timestamp without time zone default CURRENT_TIMESTAMP,
                               created_at timestamp without time zone default now(),
                               stock_id integer,
                               foreign key (stock_id) references public.stocks (id)
                                   match simple on update no action on delete no action,
                               foreign key (buy_order_id) references public.orders (id)
                                   match simple on update no action on delete no action,
                               foreign key (sell_order_id) references public.orders (id)
                                   match simple on update no action on delete no action
);

create table public.trading_sessions (
                                         tableoid oid not null,
                                         cmax cid not null,
                                         xmax xid not null,
                                         cmin cid not null,
                                         xmin xid not null,
                                         ctid tid not null,
                                         id integer primary key not null default nextval('trading_sessions_id_seq'::regclass),
                                         session_number integer not null,
                                         status character varying(20) default 'CLOSED',
                                         started_at timestamp without time zone default CURRENT_TIMESTAMP,
                                         ended_at timestamp without time zone
);

create table public.users (
                              tableoid oid not null,
                              cmax cid not null,
                              xmax xid not null,
                              cmin cid not null,
                              xmin xid not null,
                              ctid tid not null,
                              id uuid primary key not null default gen_random_uuid(),
                              username character varying(50) not null,
                              full_name character varying(100) not null,
                              password_hash text not null,
                              balance_rdn numeric(19,4) default 0,
                              created_at timestamp without time zone default CURRENT_TIMESTAMP,
                              role character varying(20) default 'USER'
);
create unique index users_username_key on users using btree (username);

create table public.watchlists (
                                   tableoid oid not null,
                                   cmax cid not null,
                                   xmax xid not null,
                                   cmin cid not null,
                                   xmin xid not null,
                                   ctid tid not null,
                                   id integer primary key not null default nextval('watchlists_id_seq'::regclass),
                                   user_id uuid not null,
                                   stock_id integer not null,
                                   created_at timestamp without time zone default now(),
                                   foreign key (stock_id) references public.stocks (id)
                                       match simple on update no action on delete cascade,
                                   foreign key (user_id) references public.users (id)
                                       match simple on update no action on delete cascade
);
create unique index watchlists_user_id_stock_id_key on watchlists using btree (user_id, stock_id);
create index idx_watchlists_user on watchlists using btree (user_id);

