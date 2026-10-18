-- Isolated proposal. Never apply to mip without independent migration approval.
BEGIN;
CREATE SCHEMA mip_fencing;
CREATE TABLE mip_fencing.protocol(version integer PRIMARY KEY CHECK(version=1));
INSERT INTO mip_fencing.protocol VALUES(1);
CREATE TABLE mip_fencing.lease(
 singleton boolean PRIMARY KEY CHECK(singleton), epoch bigint NOT NULL CHECK(epoch>=0),
 owner_id uuid, owner_pid integer, owner_start timestamptz,
 state text NOT NULL CHECK(state IN ('inactive','active'))
);
INSERT INTO mip_fencing.lease VALUES(true,0,NULL,NULL,NULL,'inactive');
CREATE TABLE mip_fencing.owner_history(
 owner_id uuid PRIMARY KEY, epoch bigint NOT NULL UNIQUE,
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION mip_fencing.session_owns_lock(p_pid integer,p_start timestamptz) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog,mip_fencing AS $$
 SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
 WHERE a.pid=p_pid AND a.backend_start=p_start AND a.datname=current_database()
 AND l.locktype='advisory' AND l.granted
 AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
 AND l.classid=((hashtext('mip:local-transition-workers')::bigint >> 32)&4294967295)::oid
 AND l.objid=(hashtext('mip:local-transition-workers')::bigint&4294967295)::oid AND l.objsubid=1)
$$;
CREATE FUNCTION mip_fencing.activate(p_owner uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mip_fencing AS $$
DECLARE f mip_fencing.lease%ROWTYPE; started timestamptz; generation bigint;
BEGIN
 IF current_setting('mip.worker_owner',true) IS DISTINCT FROM p_owner::text THEN
  RAISE EXCEPTION 'FENCE_OWNER_BINDING_REQUIRED' USING ERRCODE='55000';
 END IF;
 PERFORM pg_stat_clear_snapshot();
 SELECT backend_start INTO started FROM pg_stat_activity WHERE pid=pg_backend_pid();
 IF NOT mip_fencing.session_owns_lock(pg_backend_pid(),started) THEN
  RAISE EXCEPTION 'FENCE_ADVISORY_OWNER_REQUIRED' USING ERRCODE='55000';
 END IF;
 -- Incompatible with every business transaction's FOR SHARE until its COMMIT/ROLLBACK.
 SELECT * INTO STRICT f FROM mip_fencing.lease WHERE singleton FOR UPDATE;
 generation=f.epoch+1;
 -- A UUID can never activate a second generation, even after reconnect/retirement.
 INSERT INTO mip_fencing.owner_history(owner_id,epoch) VALUES(p_owner,generation);
 UPDATE mip_fencing.lease SET epoch=generation,owner_id=p_owner,owner_pid=pg_backend_pid(),
  owner_start=started,state='active' WHERE singleton;
 RETURN generation;
END $$;
CREATE FUNCTION mip_fencing.retire(p_owner uuid,p_epoch bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mip_fencing AS $$
BEGIN
 IF current_setting('mip.worker_owner',true) IS DISTINCT FROM p_owner::text THEN
  RAISE EXCEPTION 'FENCE_OWNER_BINDING_REQUIRED' USING ERRCODE='55000';
 END IF;
 UPDATE mip_fencing.lease SET state='inactive'
 WHERE singleton AND owner_id=p_owner AND epoch=p_epoch AND owner_pid=pg_backend_pid();
 IF NOT FOUND THEN RAISE EXCEPTION 'FENCE_STALE_RETIRE' USING ERRCODE='55000'; END IF;
END $$;
CREATE FUNCTION mip_fencing.guard_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mip_fencing AS $$
DECLARE f mip_fencing.lease%ROWTYPE; bound_owner uuid; bound_epoch bigint; stamp text;
BEGIN
 BEGIN bound_owner=nullif(current_setting('mip.worker_owner',true),'')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'FENCE_OWNER_REQUIRED' USING ERRCODE='55000';
 END;
 -- A new snapshot cannot authorize a stale UUID. RR/SERIALIZABLE may reject with 40001.
 SELECT * INTO STRICT f FROM mip_fencing.lease WHERE singleton FOR SHARE;
 SELECT epoch INTO bound_epoch FROM mip_fencing.owner_history WHERE owner_id=bound_owner;
 IF bound_owner IS NULL OR f.state<>'active' OR f.owner_id IS DISTINCT FROM bound_owner
    OR bound_epoch IS DISTINCT FROM f.epoch THEN
  RAISE EXCEPTION 'FENCE_STALE_OWNER' USING ERRCODE='55000';
 END IF;
 stamp=pg_current_xact_id()::text || ':' || bound_owner::text || ':' || bound_epoch::text;
 IF current_setting('mip.fence_transaction',true) IS DISTINCT FROM stamp THEN
  PERFORM pg_stat_clear_snapshot();
  IF NOT mip_fencing.session_owns_lock(f.owner_pid,f.owner_start) THEN
   RAISE EXCEPTION 'FENCE_OWNER_SESSION_LOST' USING ERRCODE='55000';
  END IF;
  -- Only this transaction is admitted. Local GUC and row lock roll back with savepoints.
  PERFORM set_config('mip.fence_transaction',stamp,true);
 END IF;
 -- Returning NULL is correct for a statement trigger. Row fallback supports new partitions.
 IF TG_LEVEL='STATEMENT' THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION mip_fencing.install_guards() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mip_fencing AS $$
DECLARE t record;
BEGIN
 FOR t IN SELECT c.oid,n.nspname,c.relname,c.relispartition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relispartition,c.oid
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t.oid AND tgname='mip_fence_statement') THEN
   EXECUTE format('CREATE TRIGGER mip_fence_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION mip_fencing.guard_write()',t.nspname,t.relname);
  END IF;
  EXECUTE format('ALTER TABLE %I.%I ENABLE ALWAYS TRIGGER mip_fence_statement',t.nspname,t.relname);
  IF NOT t.relispartition AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t.oid AND tgname='mip_fence_row') THEN
   EXECUTE format('CREATE TRIGGER mip_fence_row BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION mip_fencing.guard_write()',t.nspname,t.relname);
   EXECUTE format('ALTER TABLE %I.%I ENABLE ALWAYS TRIGGER mip_fence_row',t.nspname,t.relname);
  END IF;
 END LOOP;
END $$;
SELECT mip_fencing.install_guards();
CREATE FUNCTION mip_fencing.guard_new_tables() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mip_fencing AS $$
BEGIN PERFORM mip_fencing.install_guards(); END $$;
CREATE EVENT TRIGGER mip_fence_new_tables ON ddl_command_end
 WHEN TAG IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO') EXECUTE FUNCTION mip_fencing.guard_new_tables();
-- Control writes also require the actual advisory-owning session; business pools cannot forge epochs.
CREATE FUNCTION mip_fencing.guard_control() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mip_fencing AS $$
DECLARE f mip_fencing.lease%ROWTYPE; started timestamptz; bound text;
BEGIN
 IF TG_OP='TRUNCATE' OR TG_OP='DELETE' OR TG_TABLE_NAME='protocol' THEN
  RAISE EXCEPTION 'FENCE_CONTROL_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 bound=current_setting('mip.worker_owner',true);
 PERFORM pg_stat_clear_snapshot();
 SELECT backend_start INTO started FROM pg_stat_activity WHERE pid=pg_backend_pid();
 IF NOT mip_fencing.session_owns_lock(pg_backend_pid(),started) THEN
  RAISE EXCEPTION 'FENCE_CONTROL_SESSION_REQUIRED' USING ERRCODE='55000';
 END IF;
 IF TG_TABLE_NAME='owner_history' THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'FENCE_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT f FROM mip_fencing.lease WHERE singleton FOR UPDATE;
  IF NEW.owner_id::text IS DISTINCT FROM bound OR NEW.epoch<>f.epoch+1 THEN
   RAISE EXCEPTION 'FENCE_HISTORY_INVALID' USING ERRCODE='55000';
  END IF;
 ELSIF TG_TABLE_NAME='lease' THEN
  IF TG_OP<>'UPDATE' OR NEW.owner_id::text IS DISTINCT FROM bound OR NEW.owner_pid<>pg_backend_pid()
     OR NEW.owner_start<>started OR NEW.singleton IS DISTINCT FROM OLD.singleton THEN
   RAISE EXCEPTION 'FENCE_CONTROL_INVALID' USING ERRCODE='55000';
  END IF;
  IF NEW.state='active' THEN
   IF NEW.epoch<>OLD.epoch+1 OR NOT EXISTS(SELECT 1 FROM mip_fencing.owner_history h WHERE h.owner_id=NEW.owner_id AND h.epoch=NEW.epoch) THEN
    RAISE EXCEPTION 'FENCE_GENERATION_INVALID' USING ERRCODE='55000';
   END IF;
  ELSIF NEW.state='inactive' THEN
   IF NEW.epoch<>OLD.epoch OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR OLD.state<>'active' THEN
    RAISE EXCEPTION 'FENCE_RETIRE_INVALID' USING ERRCODE='55000';
   END IF;
  ELSE RAISE EXCEPTION 'FENCE_STATE_INVALID' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mip_fence_control_row BEFORE INSERT OR UPDATE OR DELETE ON mip_fencing.lease FOR EACH ROW EXECUTE FUNCTION mip_fencing.guard_control();
CREATE TRIGGER mip_fence_control_truncate BEFORE TRUNCATE ON mip_fencing.lease FOR EACH STATEMENT EXECUTE FUNCTION mip_fencing.guard_control();
CREATE TRIGGER mip_fence_control_row BEFORE INSERT OR UPDATE OR DELETE ON mip_fencing.owner_history FOR EACH ROW EXECUTE FUNCTION mip_fencing.guard_control();
CREATE TRIGGER mip_fence_control_truncate BEFORE TRUNCATE ON mip_fencing.owner_history FOR EACH STATEMENT EXECUTE FUNCTION mip_fencing.guard_control();
CREATE TRIGGER mip_fence_control_row BEFORE INSERT OR UPDATE OR DELETE ON mip_fencing.protocol FOR EACH ROW EXECUTE FUNCTION mip_fencing.guard_control();
CREATE TRIGGER mip_fence_control_truncate BEFORE TRUNCATE ON mip_fencing.protocol FOR EACH STATEMENT EXECUTE FUNCTION mip_fencing.guard_control();
ALTER TABLE mip_fencing.lease ENABLE ALWAYS TRIGGER mip_fence_control_row;
ALTER TABLE mip_fencing.lease ENABLE ALWAYS TRIGGER mip_fence_control_truncate;
ALTER TABLE mip_fencing.owner_history ENABLE ALWAYS TRIGGER mip_fence_control_row;
ALTER TABLE mip_fencing.owner_history ENABLE ALWAYS TRIGGER mip_fence_control_truncate;
ALTER TABLE mip_fencing.protocol ENABLE ALWAYS TRIGGER mip_fence_control_row;
ALTER TABLE mip_fencing.protocol ENABLE ALWAYS TRIGGER mip_fence_control_truncate;
COMMIT;
