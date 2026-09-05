/**
 * One-shot generator: ensure engine-catalog.json covers every brand/model
 * from car-specifications.json. Curated entries already present are kept.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const specs = JSON.parse(fs.readFileSync(path.join(root, 'src/data/car-specifications.json'), 'utf8'));

const e = (engine, aliases, powerCv) => ({ engine, aliases, powerCv });

/** Hand-curated engines kept as source of truth for popular models. */
const CURATED = {
  Audi: {
    A1: [
      e('1.0 TFSI', ['1.0 tfsi', '1.0 25 tfsi', '1.0 30 tfsi', '25 tfsi', '30 tfsi'], 116),
      e('1.2 TFSI', ['1.2 tfsi'], 86),
      e('1.4 TFSI', ['1.4 tfsi', '1.4'], 125),
      e('1.5 TFSI', ['1.5 tfsi', '1.5 35 tfsi', '35 tfsi'], 150),
      e('1.8 TFSI', ['1.8 tfsi'], 192),
      e('1.4 TDI', ['1.4 tdi'], 90),
      e('1.6 TDI', ['1.6 tdi', '1.6 tdi 116'], 116),
      e('2.0 TDI', ['2.0 tdi'], 143)
    ],
    A3: [
      e('1.0 TFSI', ['1.0 tfsi', '30 tfsi', '1.0 30 tfsi'], 110),
      e('1.2 TFSI', ['1.2 tfsi'], 105),
      e('1.4 TFSI', ['1.4 tfsi', '35 tfsi'], 150),
      e('1.5 TFSI', ['1.5 tfsi', '35 tfsi'], 150),
      e('1.8 TFSI', ['1.8 tfsi'], 180),
      e('2.0 TFSI', ['2.0 tfsi', '40 tfsi', '45 tfsi'], 190),
      e('1.6 TDI', ['1.6 tdi'], 110),
      e('2.0 TDI', ['2.0 tdi', '35 tdi', '40 tdi'], 150)
    ],
    A4: [
      e('1.4 TFSI', ['1.4 tfsi'], 150),
      e('1.8 TFSI', ['1.8 tfsi'], 170),
      e('2.0 TFSI', ['2.0 tfsi', '40 tfsi', '45 tfsi'], 190),
      e('2.0 TDI', ['2.0 tdi', '35 tdi', '40 tdi'], 150),
      e('3.0 TDI', ['3.0 tdi'], 218)
    ],
    Q3: [
      e('1.4 TFSI', ['1.4 tfsi', '35 tfsi'], 150),
      e('1.5 TFSI', ['1.5 tfsi', '35 tfsi'], 150),
      e('2.0 TFSI', ['2.0 tfsi', '40 tfsi', '45 tfsi'], 190),
      e('2.0 TDI', ['2.0 tdi', '35 tdi', '40 tdi'], 150)
    ]
  },
  BMW: {
    'Serie 1': [
      e('116i', ['116i', '1.5', '1.6'], 109),
      e('118i', ['118i'], 136),
      e('120i', ['120i'], 184),
      e('116d', ['116d'], 116),
      e('118d', ['118d'], 150),
      e('120d', ['120d'], 190),
      e('M135i', ['m135i'], 306)
    ],
    'Serie 3': [
      e('318i', ['318i'], 156),
      e('320i', ['320i'], 184),
      e('330i', ['330i'], 258),
      e('318d', ['318d'], 150),
      e('320d', ['320d'], 190),
      e('330d', ['330d'], 286)
    ]
  },
  Volkswagen: {
    Golf: [
      e('1.0 TSI', ['1.0 tsi', '1.0'], 110),
      e('1.2 TSI', ['1.2 tsi'], 105),
      e('1.4 TSI', ['1.4 tsi'], 125),
      e('1.5 TSI', ['1.5 tsi'], 150),
      e('2.0 TSI', ['2.0 tsi', 'gti'], 245),
      e('1.6 TDI', ['1.6 tdi'], 115),
      e('2.0 TDI', ['2.0 tdi'], 150)
    ],
    Polo: [
      e('1.0 MPI', ['1.0 mpi', '1.0'], 80),
      e('1.0 TSI', ['1.0 tsi'], 95),
      e('1.2 TSI', ['1.2 tsi'], 90),
      e('1.4 TDI', ['1.4 tdi'], 75),
      e('1.6 TDI', ['1.6 tdi'], 95)
    ]
  },
  Seat: {
    Leon: [
      e('1.0 TSI', ['1.0 tsi'], 110),
      e('1.2 TSI', ['1.2 tsi'], 105),
      e('1.4 TSI', ['1.4 tsi'], 125),
      e('1.5 TSI', ['1.5 tsi'], 150),
      e('1.6 TDI', ['1.6 tdi'], 115),
      e('2.0 TDI', ['2.0 tdi'], 150)
    ],
    Ibiza: [
      e('1.0 MPI', ['1.0 mpi', '1.0'], 80),
      e('1.0 TSI', ['1.0 tsi'], 95),
      e('1.2 TSI', ['1.2 tsi'], 90),
      e('1.6 TDI', ['1.6 tdi'], 95)
    ]
  },
  Cupra: {
    Leon: [
      e('1.5 eTSI', ['1.5 etsi', '1.5 tsi'], 150),
      e('2.0 TSI', ['2.0 tsi'], 245),
      e('2.0 TDI', ['2.0 tdi'], 150)
    ],
    Formentor: [
      e('1.5 TSI', ['1.5 tsi', '1.5 etsi'], 150),
      e('2.0 TSI', ['2.0 tsi'], 245),
      e('2.0 TDI', ['2.0 tdi'], 150)
    ]
  },
  'Mercedes-Benz': {
    'Clase A': [
      e('A 180', ['a 180', 'a180', '1.3'], 136),
      e('A 200', ['a 200', 'a200'], 163),
      e('A 180 d', ['a 180 d', 'a180d', '1.5'], 116),
      e('A 200 d', ['a 200 d', 'a200d'], 150)
    ],
    'Clase C': [
      e('C 180', ['c 180', 'c180'], 156),
      e('C 200', ['c 200', 'c200'], 184),
      e('C 220 d', ['c 220 d', 'c220d', '2.0'], 194),
      e('C 300', ['c 300', 'c300'], 258)
    ]
  },
  Toyota: {
    Yaris: [
      e('1.0 VVT-i', ['1.0', '1.0 vvt-i'], 72),
      e('1.5 Hybrid', ['1.5 hybrid', '1.5'], 116)
    ],
    Corolla: [
      e('1.8 Hybrid', ['1.8 hybrid', '1.8'], 122),
      e('2.0 Hybrid', ['2.0 hybrid', '2.0'], 184)
    ]
  },
  Renault: {
    Clio: [
      e('1.0 SCe', ['1.0 sce', '1.0'], 65),
      e('1.0 TCe', ['1.0 tce'], 90),
      e('1.5 dCi', ['1.5 dci'], 90)
    ],
    Megane: [
      e('1.2 TCe', ['1.2 tce'], 130),
      e('1.3 TCe', ['1.3 tce'], 140),
      e('1.5 dCi', ['1.5 dci'], 110),
      e('1.6 dCi', ['1.6 dci'], 130)
    ]
  },
  Peugeot: {
    208: [
      e('1.2 PureTech', ['1.2 puretech', '1.2'], 100),
      e('1.5 BlueHDi', ['1.5 bluehdi', '1.5'], 100)
    ],
    308: [
      e('1.2 PureTech', ['1.2 puretech', '1.2'], 130),
      e('1.5 BlueHDi', ['1.5 bluehdi', '1.5'], 130),
      e('1.6 BlueHDi', ['1.6 bluehdi', '1.6'], 120)
    ]
  },
  Ford: {
    Focus: [
      e('1.0 EcoBoost', ['1.0 ecoboost', '1.0'], 125),
      e('1.5 EcoBoost', ['1.5 ecoboost', '1.5'], 150),
      e('1.5 EcoBlue', ['1.5 ecoblue', '1.5 tdci'], 120),
      e('2.0 EcoBlue', ['2.0 ecoblue', '2.0 tdci'], 150)
    ],
    Fiesta: [
      e('1.0 EcoBoost', ['1.0 ecoboost', '1.0'], 100),
      e('1.1', ['1.1'], 75),
      e('1.5 TDCi', ['1.5 tdci'], 85)
    ]
  }
};

const BRAND_DEFAULTS = {
  Audi: [
    e('1.0 TFSI', ['1.0 tfsi', '30 tfsi'], 110),
    e('1.4 TFSI', ['1.4 tfsi', '35 tfsi'], 150),
    e('1.5 TFSI', ['1.5 tfsi', '35 tfsi'], 150),
    e('2.0 TFSI', ['2.0 tfsi', '40 tfsi', '45 tfsi'], 190),
    e('1.6 TDI', ['1.6 tdi'], 116),
    e('2.0 TDI', ['2.0 tdi', '35 tdi', '40 tdi'], 150),
    e('3.0 TDI', ['3.0 tdi'], 286),
    e('Electric', ['electric', 'e-tron', 'kwh'], 204)
  ],
  BMW: [
    e('118i', ['118i'], 136),
    e('120i', ['120i'], 184),
    e('320i', ['320i'], 184),
    e('320d', ['320d'], 190),
    e('330i', ['330i'], 258),
    e('330d', ['330d'], 286),
    e('xDrive20d', ['xdrive20d', '20d'], 190),
    e('xDrive30d', ['xdrive30d', '30d'], 286),
    e('Electric', ['electric', 'edrive', 'ix'], 286)
  ],
  'Mercedes-Benz': [
    e('A 180', ['a 180', 'a180'], 136),
    e('A 200', ['a 200', 'a200'], 163),
    e('C 200', ['c 200', 'c200'], 184),
    e('C 220 d', ['c 220 d', 'c220d'], 194),
    e('E 220 d', ['e 220 d', 'e220d'], 194),
    e('E 300', ['e 300', 'e300'], 258),
    e('Electric', ['electric', 'eq', 'kwh'], 190)
  ],
  Porsche: [
    e('2.0 Turbo', ['2.0', '2.0 turbo'], 300),
    e('2.5 Turbo', ['2.5', '2.5 turbo'], 380),
    e('3.0 Turbo', ['3.0', '3.0 turbo'], 450),
    e('4.0', ['4.0'], 500),
    e('Electric', ['electric', 'taycan', 'kwh'], 408)
  ],
  Volkswagen: [
    e('1.0 TSI', ['1.0 tsi', '1.0'], 110),
    e('1.5 TSI', ['1.5 tsi'], 150),
    e('2.0 TSI', ['2.0 tsi', 'gti'], 245),
    e('1.6 TDI', ['1.6 tdi'], 115),
    e('2.0 TDI', ['2.0 tdi', 'gtd'], 150),
    e('Electric', ['electric', 'id.', 'kwh'], 204)
  ],
  Toyota: [
    e('1.0 VVT-i', ['1.0', '1.0 vvt-i'], 72),
    e('1.5 Hybrid', ['1.5 hybrid', '1.5'], 116),
    e('1.8 Hybrid', ['1.8 hybrid', '1.8'], 122),
    e('2.0 Hybrid', ['2.0 hybrid', '2.0'], 184),
    e('2.5 Hybrid', ['2.5 hybrid', '2.5'], 218),
    e('Electric', ['electric', 'bz', 'kwh'], 204)
  ],
  Honda: [
    e('1.0 VTEC Turbo', ['1.0', '1.0 vtec'], 100),
    e('1.5 VTEC Turbo', ['1.5', '1.5 vtec'], 182),
    e('2.0 Hybrid', ['2.0 hybrid', 'hybrid'], 184),
    e('Electric', ['electric', 'e:ny1', 'kwh'], 204)
  ],
  Ford: [
    e('1.0 EcoBoost', ['1.0 ecoboost', '1.0'], 125),
    e('1.5 EcoBoost', ['1.5 ecoboost', '1.5'], 150),
    e('2.0 EcoBoost', ['2.0 ecoboost', '2.0'], 250),
    e('1.5 EcoBlue', ['1.5 ecoblue', '1.5 tdci'], 120),
    e('2.0 EcoBlue', ['2.0 ecoblue', '2.0 tdci'], 150),
    e('Electric', ['electric', 'mach-e', 'kwh'], 269)
  ],
  Chevrolet: [
    e('1.4 Turbo', ['1.4 turbo', '1.4'], 140),
    e('1.5 Turbo', ['1.5 turbo', '1.5'], 160),
    e('2.0 Turbo', ['2.0 turbo', '2.0'], 230),
    e('Electric', ['electric', 'bolt', 'kwh'], 204)
  ],
  Ferrari: [
    e('3.9 V8 Twin-Turbo', ['3.9', 'v8'], 720),
    e('6.5 V12', ['6.5', 'v12'], 800)
  ],
  Lamborghini: [
    e('5.2 V10', ['5.2', 'v10'], 640),
    e('6.5 V12', ['6.5', 'v12'], 770)
  ],
  Maserati: [
    e('2.0 Hybrid', ['2.0 hybrid', '2.0'], 330),
    e('3.0 V6', ['3.0', 'v6'], 430),
    e('Electric', ['electric', 'folgore', 'kwh'], 761)
  ],
  'Aston Martin': [
    e('4.0 V8 Twin-Turbo', ['4.0', 'v8'], 503),
    e('5.2 V12 Twin-Turbo', ['5.2', 'v12'], 715)
  ],
  Jaguar: [
    e('2.0 Turbo', ['2.0', '2.0 turbo'], 250),
    e('3.0 Supercharged', ['3.0'], 380),
    e('Electric', ['electric', 'i-pace', 'kwh'], 400)
  ],
  'Land Rover': [
    e('2.0 Turbo', ['2.0', '2.0 turbo', 'p250'], 249),
    e('2.0 Diesel', ['2.0 diesel', 'd200'], 204),
    e('3.0 Diesel', ['3.0 diesel', 'd300'], 300),
    e('Electric', ['electric', 'kwh'], 400)
  ],
  Volvo: [
    e('B3', ['b3', '1.5'], 163),
    e('B4', ['b4', '2.0'], 197),
    e('B5', ['b5'], 250),
    e('T5', ['t5'], 250),
    e('T6', ['t6'], 300),
    e('D4', ['d4'], 190),
    e('Electric', ['electric', 'recharge', 'kwh'], 408)
  ],
  Hyundai: [
    e('1.0 T-GDI', ['1.0 t-gdi', '1.0'], 100),
    e('1.6 T-GDI', ['1.6 t-gdi', '1.6'], 204),
    e('1.6 Hybrid', ['1.6 hybrid'], 141),
    e('1.6 CRDi', ['1.6 crdi'], 136),
    e('Electric', ['electric', 'ioniq', 'kwh'], 204)
  ],
  Kia: [
    e('1.0 T-GDI', ['1.0 t-gdi', '1.0'], 100),
    e('1.6 T-GDI', ['1.6 t-gdi', '1.6'], 204),
    e('1.6 Hybrid', ['1.6 hybrid'], 141),
    e('1.6 CRDi', ['1.6 crdi'], 136),
    e('Electric', ['electric', 'ev6', 'ev9', 'kwh'], 229)
  ],
  Nissan: [
    e('1.0 DIG-T', ['1.0 dig-t', '1.0'], 100),
    e('1.3 DIG-T', ['1.3 dig-t', '1.3'], 160),
    e('1.5 dCi', ['1.5 dci'], 110),
    e('e-Power', ['e-power', 'hybrid'], 143),
    e('Electric', ['electric', 'leaf', 'ariya', 'kwh'], 217)
  ],
  Mazda: [
    e('2.0 Skyactiv-G', ['2.0 skyactiv', '2.0'], 122),
    e('2.5 Skyactiv-G', ['2.5 skyactiv', '2.5'], 194),
    e('2.2 Skyactiv-D', ['2.2 skyactiv-d', '2.2'], 184),
    e('Electric', ['electric', 'mx-30', 'kwh'], 145)
  ],
  Tesla: [
    e('RWD', ['rwd', 'standard range'], 299),
    e('Long Range', ['long range', 'lr', 'awd'], 670),
    e('Performance', ['performance', 'plaid'], 1020)
  ],
  Lexus: [
    e('2.0 Hybrid', ['2.0 hybrid', '2.0'], 184),
    e('2.5 Hybrid', ['2.5 hybrid', '2.5'], 218),
    e('3.5 Hybrid', ['3.5 hybrid', '3.5'], 313),
    e('Electric', ['electric', 'rz', 'kwh'], 204)
  ],
  'Alfa Romeo': [
    e('1.3 MultiJet', ['1.3 multijet'], 95),
    e('1.5 Hybrid', ['1.5 hybrid', '1.5'], 130),
    e('2.0 Turbo', ['2.0 turbo', '2.0'], 280),
    e('2.2 Diesel', ['2.2 diesel', '2.2'], 210),
    e('Electric', ['electric', 'kwh'], 280)
  ],
  Genesis: [
    e('2.5 Turbo', ['2.5 turbo', '2.5'], 304),
    e('3.5 Twin-Turbo', ['3.5', '3.5 twin-turbo'], 380),
    e('Electric', ['electric', 'gv60', 'kwh'], 320)
  ],
  Mini: [
    e('1.5 TwinPower', ['1.5', 'cooper'], 136),
    e('2.0 TwinPower', ['2.0', 'cooper s', 'jcw'], 178),
    e('Electric', ['electric', 'se', 'kwh'], 184)
  ],
  Jeep: [
    e('1.3 Turbo', ['1.3 turbo', '1.3'], 150),
    e('2.0 Turbo', ['2.0 turbo', '2.0'], 270),
    e('2.2 Multijet', ['2.2 multijet', '2.2'], 200),
    e('Electric', ['electric', 'avenger', 'kwh'], 156)
  ],
  Dodge: [
    e('3.6 V6', ['3.6', 'v6'], 305),
    e('5.7 HEMI', ['5.7', 'hemi'], 375),
    e('6.2 Supercharged', ['6.2', 'hellcat'], 717)
  ],
  Ram: [
    e('3.6 V6', ['3.6', 'v6'], 305),
    e('5.7 HEMI', ['5.7', 'hemi'], 395)
  ],
  Peugeot: [
    e('1.2 PureTech', ['1.2 puretech', '1.2'], 130),
    e('1.5 BlueHDi', ['1.5 bluehdi', '1.5'], 130),
    e('1.6 PureTech', ['1.6 puretech', '1.6'], 180),
    e('Electric', ['electric', 'e-', 'kwh'], 156)
  ],
  Renault: [
    e('1.0 TCe', ['1.0 tce', '1.0'], 90),
    e('1.3 TCe', ['1.3 tce', '1.3'], 140),
    e('1.5 dCi', ['1.5 dci'], 110),
    e('E-Tech Hybrid', ['e-tech', 'hybrid'], 145),
    e('Electric', ['electric', 'zoe', 'kwh'], 220)
  ],
  'Citroën': [
    e('1.2 PureTech', ['1.2 puretech', '1.2'], 110),
    e('1.5 BlueHDi', ['1.5 bluehdi', '1.5'], 130),
    e('Electric', ['electric', 'ë', 'kwh'], 136)
  ],
  Fiat: [
    e('1.0 FireFly', ['1.0 firefly', '1.0'], 70),
    e('1.3 MultiJet', ['1.3 multijet'], 95),
    e('Hybrid', ['hybrid', '1.5'], 130),
    e('Electric', ['electric', '500e', 'kwh'], 118)
  ],
  Opel: [
    e('1.2 Turbo', ['1.2 turbo', '1.2'], 130),
    e('1.5 Diesel', ['1.5 diesel', '1.5'], 130),
    e('Electric', ['electric', 'corsa-e', 'kwh'], 136)
  ],
  Vauxhall: [
    e('1.2 Turbo', ['1.2 turbo', '1.2'], 130),
    e('1.5 Diesel', ['1.5 diesel', '1.5'], 130),
    e('Electric', ['electric', 'kwh'], 136)
  ],
  Skoda: [
    e('1.0 TSI', ['1.0 tsi', '1.0'], 110),
    e('1.5 TSI', ['1.5 tsi'], 150),
    e('2.0 TSI', ['2.0 tsi'], 190),
    e('2.0 TDI', ['2.0 tdi'], 150),
    e('Electric', ['electric', 'enyaq', 'kwh'], 204)
  ],
  Seat: [
    e('1.0 TSI', ['1.0 tsi', '1.0'], 110),
    e('1.5 TSI', ['1.5 tsi'], 150),
    e('2.0 TSI', ['2.0 tsi'], 190),
    e('2.0 TDI', ['2.0 tdi'], 150),
    e('Electric', ['electric', 'born', 'kwh'], 204)
  ],
  Cupra: [
    e('1.5 eTSI', ['1.5 etsi', '1.5 tsi'], 150),
    e('2.0 TSI', ['2.0 tsi'], 300),
    e('2.0 TDI', ['2.0 tdi'], 150),
    e('Electric', ['electric', 'born', 'kwh'], 231)
  ],
  Bentley: [
    e('4.0 V8', ['4.0', 'v8'], 550),
    e('6.0 W12', ['6.0', 'w12'], 635)
  ],
  'Rolls-Royce': [
    e('6.75 V12', ['6.75', 'v12'], 571),
    e('Electric', ['electric', 'spectre', 'kwh'], 584)
  ],
  McLaren: [
    e('3.8 V8 Twin-Turbo', ['3.8', 'v8'], 620),
    e('4.0 V8 Twin-Turbo', ['4.0', 'v8'], 720)
  ],
  Bugatti: [e('8.0 W16', ['8.0', 'w16'], 1500)],
  Pagani: [e('6.0 V12', ['6.0', 'v12'], 750)],
  Koenigsegg: [e('5.0 V8 Twin-Turbo', ['5.0', 'v8'], 1280)],
  Dacia: [
    e('1.0 SCe', ['1.0 sce', '1.0'], 67),
    e('1.0 TCe', ['1.0 tce'], 90),
    e('1.5 dCi', ['1.5 dci'], 95),
    e('Electric', ['electric', 'spring', 'kwh'], 65)
  ],
  MG: [
    e('1.5 Turbo', ['1.5 turbo', '1.5'], 169),
    e('Hybrid', ['hybrid'], 195),
    e('Electric', ['electric', 'mg4', 'kwh'], 204)
  ],
  BYD: [
    e('Electric', ['electric', 'blade', 'kwh'], 204),
    e('DM-i Hybrid', ['dm-i', 'hybrid'], 197)
  ],
  Smart: [
    e('Electric', ['electric', 'kwh'], 82),
    e('0.9 Turbo', ['0.9', '0.9 turbo'], 90)
  ],
  Abarth: [
    e('1.4 T-Jet', ['1.4 t-jet', '1.4'], 165),
    e('Electric', ['electric', '500e', 'kwh'], 155)
  ],
  Alpine: [
    e('1.8 Turbo', ['1.8 turbo', '1.8'], 300),
    e('Electric', ['electric', 'a290', 'kwh'], 220)
  ],
  Polestar: [
    e('Electric', ['electric', 'kwh'], 300),
    e('2.0 Hybrid', ['2.0 hybrid', '2.0'], 300)
  ],
  Suzuki: [
    e('1.0 Boosterjet', ['1.0 boosterjet', '1.0'], 111),
    e('1.2 Dualjet', ['1.2 dualjet', '1.2'], 90),
    e('1.4 Boosterjet', ['1.4 boosterjet', '1.4'], 129),
    e('Hybrid', ['hybrid'], 116)
  ],
  'DS Automobiles': [
    e('1.2 PureTech', ['1.2 puretech', '1.2'], 130),
    e('1.5 BlueHDi', ['1.5 bluehdi', '1.5'], 130),
    e('Electric', ['electric', 'e-tense', 'kwh'], 204)
  ],
  Mitsubishi: [
    e('1.5 Turbo', ['1.5 turbo', '1.5'], 163),
    e('2.0 Hybrid', ['2.0 hybrid', '2.0'], 188),
    e('2.2 Diesel', ['2.2 diesel', '2.2'], 150),
    e('Electric', ['electric', 'kwh'], 150)
  ],
  Subaru: [
    e('1.6 Boxer', ['1.6'], 114),
    e('2.0 Boxer', ['2.0'], 150),
    e('2.4 Boxer', ['2.4'], 260),
    e('e-Boxer Hybrid', ['e-boxer', 'hybrid'], 150)
  ],
  'Lynk & Co': [
    e('1.5 Hybrid', ['1.5 hybrid', '1.5'], 261),
    e('2.0 Turbo', ['2.0 turbo', '2.0'], 254)
  ],
  NIO: [e('Electric', ['electric', 'kwh'], 480)],
  Xpeng: [e('Electric', ['electric', 'kwh'], 430)],
  Omoda: [
    e('1.5 Turbo', ['1.5 turbo', '1.5'], 147),
    e('Electric', ['electric', 'kwh'], 204)
  ],
  Jaecoo: [
    e('1.5 Turbo', ['1.5 turbo', '1.5'], 147),
    e('1.6 Turbo', ['1.6 turbo', '1.6'], 197)
  ],
  'SsangYong / KGM': [
    e('1.5 Turbo', ['1.5 turbo', '1.5'], 163),
    e('2.2 Diesel', ['2.2 diesel', '2.2'], 202),
    e('Electric', ['electric', 'kwh'], 190)
  ],
  Infiniti: [
    e('2.0 Turbo', ['2.0 turbo', '2.0'], 211),
    e('3.0 V6', ['3.0', 'v6'], 405),
    e('3.5 Hybrid', ['3.5 hybrid', '3.5'], 364)
  ],
  Lancia: [
    e('1.0 Hybrid', ['1.0 hybrid', '1.0'], 100),
    e('1.3 MultiJet', ['1.3 multijet'], 95),
    e('Electric', ['electric', 'kwh'], 156)
  ],
  Zeekr: [e('Electric', ['electric', 'kwh'], 544)],
  Leapmotor: [e('Electric', ['electric', 'kwh'], 170)],
  'Ora (GWM)': [e('Electric', ['electric', 'kwh'], 171)],
  Voyah: [e('Electric', ['electric', 'kwh'], 489)],
  Aiways: [e('Electric', ['electric', 'kwh'], 204)],
  Hongqi: [
    e('2.0 Turbo', ['2.0 turbo', '2.0'], 252),
    e('Electric', ['electric', 'kwh'], 408)
  ],
  Maxus: [
    e('2.0 Diesel', ['2.0 diesel', '2.0'], 150),
    e('Electric', ['electric', 'kwh'], 177)
  ],
  Saab: [
    e('1.9 TiD', ['1.9 tid', '1.9'], 150),
    e('2.0 Turbo', ['2.0 turbo', '2.0'], 220)
  ],
  Chrysler: [
    e('3.6 V6', ['3.6', 'v6'], 287),
    e('Hybrid', ['hybrid', 'pacifica'], 260)
  ]
};

function isLikelyEv(model) {
  return /e-tron|id\.|electric|ev\b|eq[abes]|ioniq|leaf|ariya|model [3sxy]|taycan|bz4|mach-e|mx-30|spring|born|enyaq|zoe|corsa-e|mokka-e|500e|\bi3\b|\bi4\b|\bi5\b|\bi7\b|\bix\b|ix1|ix2|ix3|eqa|eqb|eqc|eqe|eqs|polestar|nio|xpeng|zeekr|leap|ora|voyah|aiways|spectre|plaid|folgor|e:ny1|rz\b|avenger e|mg4|ds 3 e|macan.*electric|\bbolt\b/i.test(
    model
  );
}

function modelSpecific(brand, model) {
  const m = model.toLowerCase();

  if (brand === 'Audi') {
    if (/e-tron|q4 e|q6 e|q8 e/.test(m)) {
      return [
        e('Electric 50', ['50', 'electric', 'e-tron', 'kwh'], 299),
        e('Electric 55', ['55', 'electric'], 408),
        e('S e-tron', ['s e-tron', 'rs e-tron'], 503)
      ];
    }
    if (m === 'r8') return [e('5.2 V10', ['5.2', 'v10'], 620)];
    if (m === 'tt') {
      return [
        e('1.8 TFSI', ['1.8 tfsi'], 180),
        e('2.0 TFSI', ['2.0 tfsi', 'tts'], 245),
        e('2.5 TFSI', ['2.5 tfsi', 'tt rs'], 400)
      ];
    }
    if (/^a[12]$|^q2$/.test(m)) {
      return [
        e('1.0 TFSI', ['1.0 tfsi', '30 tfsi'], 110),
        e('1.4 TFSI', ['1.4 tfsi', '35 tfsi'], 150),
        e('1.5 TFSI', ['1.5 tfsi'], 150),
        e('1.6 TDI', ['1.6 tdi'], 116),
        e('2.0 TDI', ['2.0 tdi'], 150)
      ];
    }
    if (/^a[345]$|^q[35]$/.test(m)) {
      return [
        e('1.4 TFSI', ['1.4 tfsi', '35 tfsi'], 150),
        e('1.5 TFSI', ['1.5 tfsi', '35 tfsi'], 150),
        e('2.0 TFSI', ['2.0 tfsi', '40 tfsi', '45 tfsi'], 190),
        e('2.0 TDI', ['2.0 tdi', '35 tdi', '40 tdi'], 150),
        e('3.0 TDI', ['3.0 tdi'], 286)
      ];
    }
    if (/^a[678]$|^q[78]$/.test(m)) {
      return [
        e('2.0 TFSI', ['2.0 tfsi', '45 tfsi'], 245),
        e('3.0 TFSI', ['3.0 tfsi', '55 tfsi'], 340),
        e('2.0 TDI', ['2.0 tdi', '40 tdi', '45 tdi'], 204),
        e('3.0 TDI', ['3.0 tdi', '50 tdi'], 286)
      ];
    }
  }

  if (brand === 'BMW') {
    if (/^i[3457]$|^ix/.test(m)) {
      return [
        e('eDrive', ['edrive', 'electric', 'kwh'], 286),
        e('xDrive', ['xdrive', 'm50', 'm60'], 544)
      ];
    }
    if (/serie 1|serie 2/.test(m)) {
      return [
        e('116i', ['116i'], 109),
        e('118i', ['118i'], 136),
        e('120i', ['120i'], 184),
        e('116d', ['116d'], 116),
        e('118d', ['118d'], 150),
        e('120d', ['120d'], 190),
        e('M135i / M2', ['m135i', 'm2'], 306)
      ];
    }
    if (/serie 3|serie 4/.test(m)) {
      return [
        e('318i', ['318i'], 156),
        e('320i', ['320i'], 184),
        e('330i', ['330i'], 258),
        e('318d', ['318d'], 150),
        e('320d', ['320d'], 190),
        e('330d', ['330d'], 286),
        e('M3 / M4', ['m3', 'm4'], 510)
      ];
    }
    if (/serie 5|serie 6/.test(m)) {
      return [
        e('520i', ['520i'], 184),
        e('530i', ['530i'], 252),
        e('520d', ['520d'], 190),
        e('530d', ['530d'], 286),
        e('540i', ['540i'], 340),
        e('M5 / M6', ['m5', 'm6'], 625)
      ];
    }
    if (/serie 7|serie 8/.test(m)) {
      return [
        e('740i', ['740i'], 340),
        e('750i', ['750i'], 530),
        e('730d', ['730d'], 286),
        e('740d', ['740d'], 340),
        e('M8', ['m8'], 625)
      ];
    }
    if (/^x[12]$/.test(m)) {
      return [
        e('sDrive18i', ['sdrive18i', '18i'], 136),
        e('xDrive20i', ['xdrive20i', '20i'], 178),
        e('xDrive18d', ['xdrive18d', '18d'], 150),
        e('xDrive20d', ['xdrive20d', '20d'], 190),
        e('M35i', ['m35i'], 306)
      ];
    }
    if (/^x[34]$/.test(m)) {
      return [
        e('xDrive20i', ['xdrive20i', '20i'], 184),
        e('xDrive30i', ['xdrive30i', '30i'], 245),
        e('xDrive20d', ['xdrive20d', '20d'], 190),
        e('xDrive30d', ['xdrive30d', '30d'], 286),
        e('M Competition', ['m competition', 'x3 m', 'x4 m'], 510)
      ];
    }
    if (/^x[567]$|^xm$/.test(m)) {
      return [
        e('xDrive40i', ['xdrive40i', '40i'], 340),
        e('xDrive30d', ['xdrive30d', '30d'], 286),
        e('xDrive40d', ['xdrive40d', '40d'], 340),
        e('M50i / M60i', ['m50i', 'm60i'], 530),
        e('M Competition', ['m competition', 'x5 m', 'x6 m'], 625)
      ];
    }
    if (/^z[348]$/.test(m)) {
      return [
        e('sDrive20i', ['sdrive20i', '20i'], 197),
        e('sDrive30i', ['sdrive30i', '30i'], 258),
        e('M40i', ['m40i'], 340)
      ];
    }
  }

  if (brand === 'Mercedes-Benz') {
    if (/^eq[abes]$/.test(m)) {
      return [
        e('Electric', ['electric', 'eq', 'kwh'], 292),
        e('AMG', ['amg', 'eqe amg', 'eqs amg'], 658)
      ];
    }
    if (/clase a|clase b|cla|gla|glb/.test(m)) {
      return [
        e('A/B 180', ['a 180', 'b 180', 'cla 180', '1.3'], 136),
        e('A/B 200', ['a 200', 'b 200', 'cla 200'], 163),
        e('A/B 180 d', ['a 180 d', 'b 180 d', '1.5'], 116),
        e('A/B 200 d', ['a 200 d', 'b 200 d'], 150),
        e('AMG 35 / 45', ['amg 35', 'amg 45'], 421)
      ];
    }
    if (/clase c|glc/.test(m)) {
      return [
        e('C 180', ['c 180', 'c180'], 156),
        e('C 200', ['c 200', 'c200'], 184),
        e('C 220 d', ['c 220 d', 'c220d', '2.0'], 194),
        e('C 300', ['c 300', 'c300'], 258),
        e('AMG 43 / 63', ['amg 43', 'amg 63'], 510)
      ];
    }
    if (/clase e|gle|cls/.test(m)) {
      return [
        e('200 / 300', ['e 200', 'e200', 'gle 300', '300'], 197),
        e('220 d / 300 d', ['e 220 d', 'e220d', 'gle 300 d', '220 d'], 194),
        e('400 d', ['e 400 d', 'e400d', 'gle 400 d'], 330),
        e('450', ['e 450', 'gle 450', '450'], 367),
        e('AMG 53 / 63', ['amg 53', 'amg 63'], 612)
      ];
    }
    if (/clase s|gls|clase g|amg gt|sl|gt 4/.test(m)) {
      return [
        e('450', ['s 450', 's450', '450'], 367),
        e('500', ['s 500', 's500', '500'], 435),
        e('350 d', ['s 350 d', 's350d', '350 d'], 286),
        e('400 d', ['s 400 d', 's400d', '400 d'], 330),
        e('AMG 63', ['amg 63'], 612)
      ];
    }
  }

  if (brand === 'Porsche') {
    if (m === '911') {
      return [
        e('3.0 Turbo', ['3.0', 'carrera'], 385),
        e('3.0 Turbo S', ['carrera s', 'gts'], 450),
        e('3.8 Turbo', ['turbo', 'turbo s'], 650),
        e('4.0 GT', ['gt3', 'gt3 rs', '4.0'], 525)
      ];
    }
    if (m === '718') {
      return [
        e('2.0 Turbo', ['2.0'], 300),
        e('2.5 Turbo', ['2.5'], 350),
        e('4.0', ['4.0', 'gts 4.0', 'gt4'], 400)
      ];
    }
    if (m === 'taycan') {
      return [
        e('Taycan', ['taycan', 'electric', 'kwh'], 408),
        e('Taycan 4S', ['4s'], 530),
        e('Taycan Turbo', ['turbo', 'turbo s'], 761)
      ];
    }
    if (/cayenne|macan|panamera/.test(m)) {
      return [
        e('2.0 Turbo', ['2.0'], 265),
        e('2.9 / 3.0 V6', ['2.9', '3.0', 's', 'gts'], 440),
        e('4.0 V8', ['4.0', 'turbo'], 550),
        e('E-Hybrid', ['e-hybrid', 'hybrid'], 462),
        e('Electric', ['electric', 'kwh'], 408)
      ];
    }
  }

  if (brand === 'Volkswagen') {
    if (/^id\./.test(m)) {
      return [
        e('Electric Pro', ['pro', 'electric', 'kwh'], 204),
        e('Electric GTX', ['gtx'], 299)
      ];
    }
    if (/golf|polo|t-roc|t-cross|taigo|jetta/.test(m)) {
      return [
        e('1.0 TSI', ['1.0 tsi', '1.0'], 110),
        e('1.5 TSI', ['1.5 tsi'], 150),
        e('2.0 TSI', ['2.0 tsi', 'gti', 'r'], 245),
        e('1.6 TDI', ['1.6 tdi'], 115),
        e('2.0 TDI', ['2.0 tdi', 'gtd'], 150)
      ];
    }
    if (/tiguan|passat|arteon|touran|sharan|caddy|multivan/.test(m)) {
      return [
        e('1.5 TSI', ['1.5 tsi'], 150),
        e('2.0 TSI', ['2.0 tsi', 'r'], 245),
        e('2.0 TDI', ['2.0 tdi'], 150),
        e('Hybrid / GTE', ['gte', 'hybrid'], 218)
      ];
    }
    if (/touareg|atlas/.test(m)) {
      return [
        e('2.0 TSI', ['2.0 tsi'], 245),
        e('3.0 TDI', ['3.0 tdi'], 286),
        e('Hybrid', ['hybrid', 'ehybrid'], 381)
      ];
    }
  }

  if (brand === 'Tesla') {
    return [
      e('RWD', ['rwd', 'standard range', 'rear wheel'], 299),
      e('Long Range', ['long range', 'lr', 'awd'], 670),
      e('Performance', ['performance', 'plaid'], 1020)
    ];
  }

  // Ford / Toyota / Nissan: trucks & large SUVs must not inherit city-car brand defaults.
  if (brand === 'Ford') {
    if (/^mustang$/.test(m)) {
      return [
        e('2.3 EcoBoost', ['2.3 ecoboost', '2.3'], 290),
        e('5.0 V8', ['5.0', 'v8', 'gt'], 450),
        e('5.2 V8', ['5.2', 'v8', 'shelby'], 760)
      ];
    }
    if (/mach-e|mustang mach/.test(m)) {
      return [e('Electric', ['electric', 'mach-e', 'kwh'], 269)];
    }
    if (/^f-?150$|^f150$/.test(m)) {
      return [
        e('2.7 EcoBoost', ['2.7 ecoboost', '2.7'], 325),
        e('3.5 EcoBoost', ['3.5 ecoboost', '3.5', 'v6'], 400),
        e('5.0 V8', ['5.0', 'v8'], 400),
        e('3.0 Diesel', ['3.0 diesel', 'power stroke', '3.0'], 250)
      ];
    }
    if (/^ranger$/.test(m)) {
      return [
        e('2.0 EcoBlue', ['2.0 ecoblue', '2.0 diesel'], 170),
        e('2.3 EcoBoost', ['2.3 ecoboost', '2.3'], 270),
        e('3.0 V6', ['3.0', 'v6'], 400)
      ];
    }
    if (/^bronco$/.test(m)) {
      return [
        e('2.3 EcoBoost', ['2.3 ecoboost', '2.3'], 275),
        e('2.7 EcoBoost', ['2.7 ecoboost', '2.7'], 315)
      ];
    }
    if (/^explorer$|^expedition$/.test(m)) {
      return [
        e('2.3 EcoBoost', ['2.3 ecoboost', '2.3'], 300),
        e('3.0 EcoBoost', ['3.0 ecoboost', '3.0', 'v6'], 400),
        e('3.5 EcoBoost', ['3.5 ecoboost', '3.5'], 440)
      ];
    }
  }

  if (brand === 'Toyota') {
    if (/land cruiser/.test(m)) {
      return [
        e('2.8 Diesel', ['2.8 diesel', '2.8'], 204),
        e('3.3 V6 Diesel', ['3.3', 'v6 diesel', '3.3 diesel'], 309),
        e('4.0 V6', ['4.0', 'v6'], 275)
      ];
    }
    if (/^hilux$/.test(m)) {
      return [
        e('2.4 Diesel', ['2.4 diesel', '2.4'], 150),
        e('2.8 Diesel', ['2.8 diesel', '2.8'], 204)
      ];
    }
    if (/^tundra$/.test(m)) {
      return [
        e('3.4 V6', ['3.4', 'v6', 'i-force'], 389),
        e('3.5 V6 Hybrid', ['3.5 hybrid', 'i-force max'], 437)
      ];
    }
    if (/^tacoma$/.test(m)) {
      return [
        e('2.4 Turbo', ['2.4 turbo', '2.4'], 278),
        e('2.4 Hybrid', ['2.4 hybrid', 'i-force max'], 326)
      ];
    }
    if (/^4runner$|^sequoia$/.test(m)) {
      return [
        e('2.4 Turbo', ['2.4 turbo', '2.4'], 278),
        e('3.5 V6', ['3.5', 'v6'], 389),
        e('Hybrid', ['hybrid', 'i-force max'], 437)
      ];
    }
    if (/^supra$/.test(m)) {
      return [
        e('2.0 Turbo', ['2.0 turbo', '2.0'], 258),
        e('3.0 Turbo', ['3.0 turbo', '3.0'], 387)
      ];
    }
    if (/^gr86$|^gt86$|^86$/.test(m)) {
      return [e('2.4 Boxer', ['2.4', 'boxer'], 234)];
    }
  }

  if (brand === 'Nissan') {
    if (/^navara$|^frontier$/.test(m)) {
      return [
        e('2.3 Diesel', ['2.3 diesel', '2.3'], 190),
        e('2.5', ['2.5'], 188),
        e('3.0 Diesel', ['3.0 diesel', '3.0'], 231)
      ];
    }
    if (/^patrol$|^armada$/.test(m)) {
      return [
        e('2.8 Diesel', ['2.8 diesel', '2.8'], 200),
        e('4.0 V6', ['4.0', 'v6'], 275),
        e('5.6 V8', ['5.6', 'v8'], 400)
      ];
    }
    if (/^titan$/.test(m)) {
      return [e('5.6 V8', ['5.6', 'v8'], 400)];
    }
    if (/^gt-?r$|^gtr$/.test(m)) {
      return [e('3.8 V6 Twin-Turbo', ['3.8', 'v6', 'twin-turbo'], 570)];
    }
    if (/^z$|^370z$|^350z$/.test(m)) {
      return [
        e('3.0 Twin-Turbo', ['3.0', 'twin-turbo'], 400),
        e('3.7 V6', ['3.7', 'v6'], 350)
      ];
    }
    if (/^leaf$|^ariya$/.test(m)) {
      return [e('Electric', ['electric', 'leaf', 'ariya', 'kwh'], 217)];
    }
  }

  // Chevrolet's lineup spans city cars, sports cars and full-size
  // trucks/SUVs — a single small-turbo default is wrong for most of it.
  if (brand === 'Chevrolet') {
    if (/^spark$/.test(m)) {
      return [e('1.0', ['1.0'], 68), e('1.4', ['1.4'], 101)];
    }
    if (/^malibu$/.test(m)) {
      return [
        e('1.5 Turbo', ['1.5 turbo', '1.5'], 163),
        e('2.0 Turbo', ['2.0 turbo', '2.0'], 250),
        e('3.6 V6', ['3.6', 'v6'], 305)
      ];
    }
    if (/^camaro$/.test(m)) {
      return [
        e('2.0 Turbo', ['2.0 turbo', '2.0'], 275),
        e('3.6 V6', ['3.6', 'v6'], 335),
        e('6.2 V8', ['6.2', 'v8', 'ss'], 461),
        e('6.2 V8 Supercharged', ['6.2 supercharged', 'zl1'], 650)
      ];
    }
    if (/^corvette$/.test(m)) {
      return [
        e('6.2 V8', ['6.2', 'v8', 'stingray'], 495),
        e('5.5 V8', ['5.5', 'z06'], 670),
        e('6.2 V8 Supercharged', ['6.2 supercharged', 'zr1'], 830)
      ];
    }
    if (/^trax$/.test(m)) {
      return [
        e('1.2 Turbo', ['1.2 turbo', '1.2'], 116),
        e('1.4 Turbo', ['1.4 turbo', '1.4'], 140)
      ];
    }
    if (/^trailblazer$/.test(m)) {
      return [
        e('1.2 Turbo', ['1.2 turbo', '1.2'], 120),
        e('1.3 Turbo', ['1.3 turbo', '1.3'], 155)
      ];
    }
    if (/^equinox$/.test(m)) {
      return [
        e('1.5 Turbo', ['1.5 turbo', '1.5'], 175),
        e('2.0 Turbo', ['2.0 turbo', '2.0'], 227)
      ];
    }
    if (/^blazer$/.test(m)) {
      return [
        e('2.0 Turbo', ['2.0 turbo', '2.0'], 230),
        e('3.6 V6', ['3.6', 'v6'], 308)
      ];
    }
    if (/^traverse$/.test(m)) {
      return [
        e('2.0 Turbo', ['2.0 turbo', '2.0'], 230),
        e('3.6 V6', ['3.6', 'v6'], 314)
      ];
    }
    if (/^tahoe$|^suburban$/.test(m)) {
      return [
        e('5.3 V8', ['5.3', 'v8'], 355),
        e('6.2 V8', ['6.2', 'v8'], 425),
        e('3.0 Diesel', ['3.0 diesel', 'duramax', '3.0'], 277)
      ];
    }
    if (/^colorado$/.test(m)) {
      return [
        e('2.7 Turbo', ['2.7 turbo', '2.7'], 237),
        e('3.6 V6', ['3.6', 'v6'], 308),
        e('2.8 Diesel', ['2.8 diesel', 'duramax', '2.8'], 200)
      ];
    }
    if (/^silverado/.test(m)) {
      return [
        e('2.7 Turbo', ['2.7 turbo', '2.7'], 310),
        e('4.3 V6', ['4.3', 'v6'], 285),
        e('5.3 V8', ['5.3', 'v8'], 355),
        e('6.2 V8', ['6.2', 'v8'], 420),
        e('3.0 Diesel', ['3.0 diesel', 'duramax', '3.0'], 277)
      ];
    }
  }

  return null;
}

function enginesFor(brand, model) {
  if (CURATED[brand]?.[model]?.length) return CURATED[brand][model];

  const specific = modelSpecific(brand, model);
  if (specific?.length) return specific;

  const defaults = BRAND_DEFAULTS[brand];
  if (!defaults) {
    return [
      e('1.5 Turbo', ['1.5 turbo', '1.5'], 150),
      e('2.0 Turbo', ['2.0 turbo', '2.0'], 190),
      e('Electric', ['electric', 'kwh'], 200)
    ];
  }
  if (isLikelyEv(model)) {
    const ev = defaults.filter((x) =>
      /electric|e-tech|hybrid|rwd|long range|performance|dm-i/i.test(x.engine)
    );
    return ev.length ? ev : [e('Electric', ['electric', 'kwh'], 204)];
  }
  const ice = defaults.filter((x) => x.engine !== 'Electric');
  return ice.length ? ice : defaults;
}

const out = {};
let totalModels = 0;
let curatedKept = 0;
let modelSpecificCount = 0;
for (const [brand, models] of Object.entries(specs)) {
  out[brand] = {};
  for (const model of Object.keys(models)) {
    totalModels++;
    out[brand][model] = enginesFor(brand, model);
    if (CURATED[brand]?.[model]) curatedKept++;
    else if (modelSpecific(brand, model)) modelSpecificCount++;
  }
}

const outPath = path.join(root, 'src/data/engine-catalog.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

let covered = 0;
let empty = 0;
const missingBrands = [];
for (const [brand, models] of Object.entries(specs)) {
  if (!BRAND_DEFAULTS[brand] && !CURATED[brand]) missingBrands.push(brand);
  for (const model of Object.keys(models)) {
    if (out[brand]?.[model]?.length) covered++;
    else empty++;
  }
}

console.log(
  JSON.stringify(
    {
      totalModels,
      covered,
      empty,
      curatedKept,
      modelSpecificCount,
      brands: Object.keys(out).length,
      missingBrandDefaults: missingBrands,
      bytes: fs.statSync(outPath).size
    },
    null,
    2
  )
);
