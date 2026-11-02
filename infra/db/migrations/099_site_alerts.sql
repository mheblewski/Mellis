-- Infusion site pushes (site-alerts.v1, owner 2026-11-02), in "Powiadomienia o sprzęcie": "Czas zmienić wkłucie" once
-- the newest "Site Change" in Nightscout is older than 48 hours, once per site.
--
-- patient_devices.site_push_enabled: the switch "Wkłucie", on by default like "Zbiornik insuliny".
-- site_alert_states: one row per patient; notified_site_changed_at is the site change the last push was about (a
-- newer change starts the count again). revision makes the claim before a push one worker's (compare and set).

ALTER TABLE patient_devices ADD COLUMN IF NOT EXISTS site_push_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS site_alert_states (
  patient_id uuid PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  notified_site_changed_at timestamptz NULL,
  notified_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
