-- migration_add_user_role.sql
-- Migration untuk menambahkan kolom role ke tabel users

-- 1. Tambahkan kolom role ke users
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS role varchar(20) DEFAULT 'USER'
CONSTRAINT users_role_check CHECK (role IN ('USER', 'ADMIN'));

-- 2. Set user pertama sebagai admin (optional - sesuaikan dengan kebutuhan)
-- UPDATE users SET role = 'ADMIN' WHERE username = 'admin';

-- 3. Buat admin user jika belum ada
-- Password: admin123 (hash menggunakan bcrypt)
-- Anda bisa generate hash baru di https://bcrypt-generator.com/
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin') THEN
        INSERT INTO users (username, full_name, password_hash, balance_rdn, role)
        VALUES (
            'admin',
            'System Administrator',
            '$2b$10$rQZ8K.5JjLqYVQZ8K5JjLuGpDHm/5vVqZ8K5JjLqYVQZ8K5JjLqYV', -- Ganti dengan hash yang valid
            0,
            'ADMIN'
        );
        RAISE NOTICE 'Admin user created successfully';
    ELSE
        -- Update existing admin user to have ADMIN role
        UPDATE users SET role = 'ADMIN' WHERE username = 'admin';
        RAISE NOTICE 'Admin user updated to ADMIN role';
    END IF;
END $$;

-- 4. Verify
SELECT id, username, full_name, role, created_at FROM users ORDER BY created_at;

