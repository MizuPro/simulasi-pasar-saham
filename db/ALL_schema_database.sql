create table public.users
(
    id            uuid           default gen_random_uuid() not null
        primary key,
    username      varchar(50)                              not null
        unique,
    full_name     varchar(100)                             not null,
    password_hash text                                     not null,
    balance_rdn   numeric(19, 4) default 0
        constraint users_balance_rdn_check
            check (balance_rdn >= (0)::numeric),
    created_at    timestamp      default CURRENT_TIMESTAMP
);

alter table public.users
    owner to michael;

create table public.stocks
(
    id        serial
        primary key,
    symbol    varchar(10)  not null
        unique,
    name      varchar(100) not null,
    is_active boolean default true
);

alter table public.stocks
    owner to michael;

create table public.trading_sessions
(
    id             serial
        primary key,
    session_number integer not null,
    status         varchar(20) default 'CLOSED'::character varying
        constraint trading_sessions_status_check
            check ((status)::text = ANY ((ARRAY ['OPEN'::character varying, 'CLOSED'::character varying])::text[])),
    started_at     timestamp   default CURRENT_TIMESTAMP,
    ended_at       timestamp
);

alter table public.trading_sessions
    owner to michael;

create table public.daily_stock_data
(
    id          serial
        primary key,
    session_id  integer
        references public.trading_sessions
            on delete cascade,
    stock_id    integer
        references public.stocks
            on delete cascade,
    prev_close  numeric(19, 4) not null,
    open_price  numeric(19, 4),
    high_price  numeric(19, 4),
    low_price   numeric(19, 4),
    close_price numeric(19, 4),
    ara_limit   numeric(19, 4) not null,
    arb_limit   numeric(19, 4) not null,
    volume      bigint default 0,
    unique (session_id, stock_id)
);

alter table public.daily_stock_data
    owner to michael;

create index idx_daily_stock_session
    on public.daily_stock_data (session_id, stock_id);

create table public.orders
(
    id                 uuid        default gen_random_uuid() not null
        primary key,
    user_id            uuid
        references public.users,
    stock_id           integer
        references public.stocks,
    session_id         integer
        references public.trading_sessions,
    type               varchar(10)                           not null
        constraint orders_type_check
            check ((type)::text = ANY ((ARRAY ['BUY'::character varying, 'SELL'::character varying])::text[])),
    price              numeric(19, 4)                        not null,
    quantity           integer                               not null
        constraint orders_quantity_check
            check (quantity > 0),
    remaining_quantity integer                               not null,
    status             varchar(20) default 'PENDING'::character varying
        constraint orders_status_check
            check ((status)::text = ANY
                   ((ARRAY ['PENDING'::character varying, 'MATCHED'::character varying, 'PARTIAL'::character varying, 'CANCELED'::character varying, 'REJECTED'::character varying])::text[])),
    created_at         timestamp   default CURRENT_TIMESTAMP
);

alter table public.orders
    owner to michael;

create index idx_orders_status_stock
    on public.orders (status, stock_id, price);

create table public.trades
(
    id            uuid      default gen_random_uuid() not null
        primary key,
    buy_order_id  uuid
        references public.orders,
    sell_order_id uuid
        references public.orders,
    price         numeric(19, 4)                      not null,
    quantity      integer                             not null,
    executed_at   timestamp default CURRENT_TIMESTAMP,
    created_at    timestamp default now()
);

alter table public.trades
    owner to michael;

create table public.portfolios
(
    user_id        uuid    not null
        references public.users,
    stock_id       integer not null
        references public.stocks,
    quantity_owned integer        default 0
        constraint portfolios_quantity_owned_check
            check (quantity_owned >= 0),
    avg_buy_price  numeric(19, 4) default 0,
    primary key (user_id, stock_id)
);

alter table public.portfolios
    owner to michael;

create table public.stock_candles
(
    id          serial
        primary key,
    stock_id    integer        not null
        references public.stocks,
    resolution  varchar(5) default '1M'::character varying,
    open_price  numeric(15, 2) not null,
    high_price  numeric(15, 2) not null,
    low_price   numeric(15, 2) not null,
    close_price numeric(15, 2) not null,
    volume      integer        not null,
    start_time  timestamp      not null,
    created_at  timestamp  default now()
);

alter table public.stock_candles
    owner to michael;

create index idx_candles_stock_time
    on public.stock_candles (stock_id, start_time);

-- Tabel candles untuk multi-timeframe support (1m, 5m, 15m, 1h, 1d)
create table public.candles
(
    id          serial
        primary key,
    stock_id    integer        not null
        references public.stocks
            on delete cascade,
    timeframe   varchar(5)     not null default '1m',
    open_price  numeric(15, 2) not null,
    high_price  numeric(15, 2) not null,
    low_price   numeric(15, 2) not null,
    close_price numeric(15, 2) not null,
    volume      integer        not null default 0,
    timestamp   timestamp      not null,
    created_at  timestamp      default now(),
    unique (stock_id, timeframe, timestamp)
);

alter table public.candles
    owner to michael;

create index idx_candles_multi_timeframe
    on public.candles (stock_id, timeframe, timestamp);

-- Tabel watchlists untuk menyimpan saham favorit user
create table public.watchlists
(
    id         serial
        primary key,
    user_id    uuid        not null
        references public.users
            on delete cascade,
    stock_id   integer     not null
        references public.stocks
            on delete cascade,
    created_at timestamp   default now(),
    unique (user_id, stock_id)
);

alter table public.watchlists
    owner to michael;

create index idx_watchlists_user
    on public.watchlists (user_id);

-- Tambah kolom filled_quantity dan average_price pada orders (jika belum ada)
-- ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS filled_quantity integer default 0;
-- ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS average_price numeric(19, 4);
