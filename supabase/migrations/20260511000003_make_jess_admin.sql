-- Promote the project owner account to admin when this account exists.
-- The custom access-token hook reads public.profiles.is_admin and injects
-- app_metadata.is_admin=true into newly issued JWTs.

insert into public.profiles (id, is_admin, display_name)
select id, true, coalesce(raw_user_meta_data->>'full_name', email)
from auth.users
where lower(email) = 'jecaboccardo@gmail.com'
on conflict (id) do update
set is_admin = true,
    display_name = coalesce(public.profiles.display_name, excluded.display_name);
