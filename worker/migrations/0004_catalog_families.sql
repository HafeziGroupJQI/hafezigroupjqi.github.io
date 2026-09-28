-- The lab's real instruments, as catalog families for the web builder. Generated from the same
-- spec as ~/src/agent/catalog/<Family>/ (Instrument.json + IO_ports.json) so the two stay in step.
-- INSERT OR IGNORE: re-running is harmless, and hand edits made on the site are kept.

INSERT OR IGNORE INTO catalog (family, display_name, description, ports, capabilities, examples, updated_ns) VALUES (
  'BKtel_CPFL',
  'BKtel CPFL-1550 pulsed fibre laser',
  'Pulsed fibre laser on RS-232 over a USB-serial adapter: 9600 8N1, CR LF, a plain-text command set (ri/rit/ra/rwl/swl/rcc), not SCPI.',
  '[{"id":"optical_out","label":"Optical output (FC/APC)","direction":"source"}]',
  '{"readable":true,"settable":true}',
  '[]',
  0
);
INSERT OR IGNORE INTO catalog (family, display_name, description, ports, capabilities, examples, updated_ns) VALUES (
  'OptoPlex',
  'OptoPlex tunable optical filter',
  'Tunable filter on RS-232: 9600 8N1, CR LF, line-oriented replies. Only the ?R query is known from the lab''s scripts.',
  '[{"id":"optical_in","label":"Optical input","direction":"measure"},{"id":"optical_out","label":"Optical output","direction":"source"}]',
  '{"readable":true}',
  '[]',
  0
);
INSERT OR IGNORE INTO catalog (family, display_name, description, ports, capabilities, examples, updated_ns) VALUES (
  'NewportCONEX',
  'Newport CONEX-CC motion controller',
  'DC-servo actuator controller over its virtual COM port: 921600 8N1, XON/XOFF, CR LF, the ASCII command set (1TS, 1TP, 1PA, 1OR).',
  '[{"id":"actuator","label":"Actuator","direction":"source"}]',
  '{"readable":true,"settable":true,"movable":true}',
  '[]',
  0
);
INSERT OR IGNORE INTO catalog (family, display_name, description, ports, capabilities, examples, updated_ns) VALUES (
  'ThorlabsK10CR',
  'Thorlabs K10CR1/K10CR2 rotation mount',
  'Motorised rotation mount over the Kinesis/APT protocol (pylablib). The address is the stage''s serial number. Needs the Thorlabs Kinesis driver installed.',
  '[{"id":"mount","label":"Rotation mount","direction":"source"}]',
  '{"readable":true,"settable":true,"movable":true}',
  '[]',
  0
);
INSERT OR IGNORE INTO catalog (family, display_name, description, ports, capabilities, examples, updated_ns) VALUES (
  'MightexCCD',
  'Mightex USB-BUF-CCD camera',
  'Buffered USB CCD camera through the Mightex SDK DLL (C2_MIGHTEX_DLL_DIR). Unverified on hardware.',
  '[{"id":"sensor","label":"Sensor","direction":"measure"},{"id":"trigger_in","label":"Trigger in","direction":"measure"}]',
  '{"readable":true,"settable":true,"image":true}',
  '[]',
  0
);
INSERT OR IGNORE INTO catalog (family, display_name, description, ports, capabilities, examples, updated_ns) VALUES (
  'ZurichSHFSG',
  'Zurich Instruments SHFSG signal generator',
  'Four-channel microwave signal generator over a LabOne session (zhinst-toolkit). The address is the device id.',
  '[{"id":"rf_out_1","label":"RF Out 1","direction":"source"},{"id":"rf_out_2","label":"RF Out 2","direction":"source"},{"id":"rf_out_3","label":"RF Out 3","direction":"source"},{"id":"rf_out_4","label":"RF Out 4","direction":"source"},{"id":"trigger_in","label":"Trigger In","direction":"measure"},{"id":"ref_clk_in","label":"Ref Clk In","direction":"measure"},{"id":"ref_clk_out","label":"Ref Clk Out","direction":"source"}]',
  '{"readable":true,"settable":true,"switchable":true}',
  '[]',
  0
);
INSERT OR IGNORE INTO catalog (family, display_name, description, ports, capabilities, examples, updated_ns) VALUES (
  'NIDAQ',
  'NI USB DAQ (analog in)',
  'Analog input through NI-DAQmx (needs the NI-DAQmx driver). The address is the DAQmx device name, e.g. Dev1.',
  '[{"id":"ai0","label":"AI0 (trigger)","direction":"measure"},{"id":"ai1","label":"AI1 (monitor)","direction":"measure"},{"id":"ai2","label":"AI2 (detector)","direction":"measure"}]',
  '{"readable":true}',
  '[]',
  0
);
INSERT OR IGNORE INTO catalog (family, display_name, description, ports, capabilities, examples, updated_ns) VALUES (
  'Santec_TSL',
  'Santec TSL-710 tunable laser',
  'Tunable laser over GPIB (SCPI). Needs NI-VISA + NI-488.2; opened with the vendor VISA (backend @ivi).',
  '[{"id":"optical_out","label":"Optical output","direction":"source"}]',
  '{"readable":true,"settable":true,"switchable":true}',
  '[]',
  0
);
INSERT OR IGNORE INTO catalog (family, display_name, description, ports, capabilities, examples, updated_ns) VALUES (
  'PM100D',
  'Thorlabs PM100D optical power meter',
  'Power-meter console over USB-TMC, plain SCPI (MEAS:POW?). Works with pyvisa-py (@py) or the vendor VISA.',
  '[{"id":"sensor_in","label":"Sensor input","direction":"measure"},{"id":"analog_out","label":"Analog output","direction":"source"}]',
  '{"readable":true}',
  '[]',
  0
);

INSERT OR IGNORE INTO migrations (id) VALUES ('catalog-families');
