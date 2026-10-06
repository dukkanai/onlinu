-- New, dedicated PostgreSQL 16 instance only. Invoked by the official image's
-- empty-data-directory init hook as its bootstrap administrator. Never mounted
-- in the restaurant container, never run by the public control plane.
DO $onlinu_bootstrap$
DECLARE
    runtime_password text;
BEGIN
    IF current_setting('server_version_num')::integer / 10000 <> 16 THEN
        RAISE EXCEPTION 'unsupported fixture database version';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onlinu_runtime') THEN
        RAISE EXCEPTION 'runtime role already exists';
    END IF;
    IF (pg_stat_file('/run/secrets/runtime_password')).isdir
       OR (pg_stat_file('/run/secrets/runtime_password')).size > 65536 THEN
        RAISE EXCEPTION 'invalid runtime credential file';
    END IF;
    runtime_password := pg_read_file('/run/secrets/runtime_password', 0, 65537);
    runtime_password := regexp_replace(runtime_password, E'[\\r\\n]+$', '');
    IF runtime_password = '' OR runtime_password ~ '^[[:space:]]*$'
       OR runtime_password ~ E'[\\r\\n]' OR octet_length(runtime_password) > 65536 THEN
        RAISE EXCEPTION 'invalid runtime credential value';
    END IF;
    EXECUTE format('CREATE ROLE onlinu_runtime LOGIN NOSUPERUSER NOCREATEROLE CREATEDB NOREPLICATION NOBYPASSRLS PASSWORD %L', runtime_password);
EXCEPTION WHEN OTHERS THEN
    -- Replace the original diagnostic, not its potentially sensitive value.
    RAISE EXCEPTION USING MESSAGE = 'onlinu runtime role bootstrap failed', DETAIL = '', HINT = '';
END;
$onlinu_bootstrap$;
