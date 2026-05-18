-- sync_check_protocol() is SECURITY INVOKER and already fenced by authenticated-only RLS.
-- Grant table-level SELECT so authenticated clients can execute the probe without 403.
GRANT SELECT ON TABLE public.sync_protocol_state TO authenticated;
