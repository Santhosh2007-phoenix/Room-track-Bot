import { X, Navigation, Building2, Footprints } from 'lucide-react';

interface PatientLocation {
  id?: string | number;
  patient_id?: string;
  name: string;
  floor: string;
  room: string;
  father_name?: string;
  city?: string;
  department?: string;
}

interface FloorMapModalProps {
  patient: PatientLocation;
  onClose: () => void;
}

export function FloorMapModal({ patient, onClose }: FloorMapModalProps) {
  // Parse room number to determine layout position
  const cleanRoom = (patient.room || '').trim();
  const roomDigits = cleanRoom.replace(/\D/g, '');
  const lastDigit = roomDigits ? parseInt(roomDigits.slice(-1), 10) : 1;
  const floorName = patient.floor || '2F';

  // Room coordinates on SVG canvas (width: 760, height: 430)
  // Top row: y = 25, height = 145. Corridor: y = 175 to 255. Bottom row: y = 260, height = 145.
  const roomsLayout = [
    {
      id: 'r1',
      num: `${floorName.replace(/\D/g, '') || '1'}01`,
      matchDigits: [1],
      label: 'Room ' + `${floorName.replace(/\D/g, '') || '1'}01`,
      type: 'General Ward',
      x: 160,
      y: 25,
      w: 160,
      h: 140,
      doorX: 240,
      doorY: 165,
      side: 'LEFT'
    },
    {
      id: 'r2',
      num: `${floorName.replace(/\D/g, '') || '1'}02`,
      matchDigits: [2],
      label: 'Room ' + `${floorName.replace(/\D/g, '') || '1'}02`,
      type: 'Special Ward',
      x: 340,
      y: 25,
      w: 160,
      h: 140,
      doorX: 420,
      doorY: 165,
      side: 'LEFT'
    },
    {
      id: 'r3',
      num: `${floorName.replace(/\D/g, '') || '1'}03`,
      matchDigits: [3],
      label: 'Room ' + `${floorName.replace(/\D/g, '') || '1'}03`,
      type: 'Deluxe Room',
      x: 520,
      y: 25,
      w: 160,
      h: 140,
      doorX: 600,
      doorY: 165,
      side: 'LEFT'
    },
    {
      id: 'r4',
      num: `${floorName.replace(/\D/g, '') || '1'}04`,
      matchDigits: [4],
      label: 'Room ' + `${floorName.replace(/\D/g, '') || '1'}04`,
      type: 'ICU / Recovery',
      x: 160,
      y: 265,
      w: 160,
      h: 140,
      doorX: 240,
      doorY: 265,
      side: 'RIGHT'
    },
    {
      id: 'r5',
      num: `${floorName.replace(/\D/g, '') || '1'}05`,
      matchDigits: [5, 6, 7, 8, 9, 0],
      label: 'Room ' + (cleanRoom.length > 0 ? cleanRoom : `${floorName.replace(/\D/g, '') || '1'}05`),
      type: 'Observation Room',
      x: 340,
      y: 265,
      w: 160,
      h: 140,
      doorX: 420,
      doorY: 265,
      side: 'RIGHT'
    }
  ];

  // Find targeted room (default to Room 2 or matched last digit)
  const targetRoomIndex = roomsLayout.findIndex(r => 
    r.label.toLowerCase().includes(cleanRoom.toLowerCase()) || 
    r.matchDigits.includes(lastDigit)
  );
  const activeRoom = roomsLayout[targetRoomIndex >= 0 ? targetRoomIndex : 1];

  // Route points: Start at Elevator (x=90, y=215), traverse corridor to doorX, then to doorY
  const startX = 85;
  const startY = 215;
  const cornerX = activeRoom.doorX;
  const cornerY = 215;
  const targetDoorX = activeRoom.doorX;
  const targetDoorY = activeRoom.doorY;

  const pathD = `M ${startX} ${startY} L ${cornerX} ${cornerY} L ${targetDoorX} ${targetDoorY}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-slate-900/70 backdrop-blur-sm animate-fadeIn" style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(15, 23, 42, 0.75)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div 
        className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl overflow-hidden flex flex-col"
        style={{ background: '#ffffff', borderRadius: '20px', maxWidth: '860px', width: '100%', maxHeight: '95vh', overflowY: 'auto', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)', border: '1px solid #e2e8f0' }}
      >
        {/* Modal Header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '44px', height: '44px', borderRadius: '12px', background: '#e0f2fe', color: '#0284c7', display: 'grid', placeItems: 'center' }}>
              <Navigation size={24} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, color: '#0f172a' }}>
                  Indoor Navigation & Floor Map
                </h2>
                <span style={{ background: '#0f766e', color: 'white', fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: '999px' }}>
                  Floor {patient.floor}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: '0.85rem', color: '#64748b' }}>
                Guiding to <b>{patient.name}</b> in <b>Room {patient.room}</b>
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            style={{ width: '36px', height: '36px', borderRadius: '10px', border: '1px solid #e2e8f0', background: 'white', color: '#64748b', display: 'grid', placeItems: 'center', cursor: 'pointer' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* 2D Interactive Blueprint Map */}
        <div style={{ padding: '20px 24px 10px', background: '#0f172a' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', color: '#94a3b8', fontSize: '0.8rem' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Building2 size={15} style={{ color: '#38bdf8' }} /> Hospital Wing Blueprint • <b>Floor {patient.floor}</b>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981' }} /> Target Room
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#38bdf8' }} /> Elevator / Entry
              </span>
            </span>
          </div>

          {/* SVG Map Container */}
          <div style={{ width: '100%', overflowX: 'auto', background: '#1e293b', borderRadius: '16px', border: '1px solid #334155', padding: '10px' }}>
            <svg viewBox="0 0 760 430" style={{ width: '100%', height: 'auto', display: 'block', minWidth: '600px' }}>
              <defs>
                {/* Glow Filter for Target Room */}
                <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur stdDeviation="8" result="blur" />
                  <feComposite in="SourceGraphic" in2="blur" operator="over" />
                </filter>

                {/* Animated Dash Pattern */}
                <style>{`
                  @keyframes walkingPathAnim {
                    from { stroke-dashoffset: 40; }
                    to { stroke-dashoffset: 0; }
                  }
                  .walking-route {
                    stroke-dasharray: 8 6;
                    animation: walkingPathAnim 1.2s linear infinite;
                  }
                  @keyframes pulsePin {
                    0% { transform: scale(1); }
                    50% { transform: scale(1.18); }
                    100% { transform: scale(1); }
                  }
                  .pin-bouncing {
                    transform-origin: center;
                    animation: pulsePin 1.6s ease-in-out infinite;
                  }
                `}</style>

                {/* Arrowhead marker */}
                <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#10b981" />
                </marker>
              </defs>

              {/* Main Hallway Corridor background */}
              <rect x="130" y="175" width="580" height="80" rx="8" fill="#0f172a" stroke="#334155" strokeWidth="1.5" />
              <text x="420" y="220" textAnchor="middle" fill="#475569" fontSize="12" fontWeight="700" letterSpacing="3">
                CENTRAL CORRIDOR / HALLWAY
              </text>

              {/* Elevator / Lift Lobby (Starting Point) */}
              <g>
                <rect x="20" y="150" width="105" height="130" rx="12" fill="#0369a1" stroke="#38bdf8" strokeWidth="2" />
                <rect x="35" y="165" width="75" height="70" rx="6" fill="#0c4a6e" stroke="#0284c7" />
                <text x="72" y="195" textAnchor="middle" fill="#e0f2fe" fontSize="11" fontWeight="700">LIFT / ELEVATOR</text>
                <text x="72" y="215" textAnchor="middle" fill="#7dd3fc" fontSize="10">Floor {patient.floor}</text>
                <circle cx="72" cy="255" r="12" fill="#38bdf8" />
                <text x="72" y="259" textAnchor="middle" fill="#0c4a6e" fontSize="10" fontWeight="900">START</text>
              </g>

              {/* Nurse Station (Bottom Right) */}
              <g>
                <rect x="520" y="265" width="160" height="140" rx="12" fill="#1e293b" stroke="#334155" strokeWidth="1.5" />
                <rect x="535" y="280" width="130" height="30" rx="6" fill="#334155" />
                <text x="600" y="300" textAnchor="middle" fill="#94a3b8" fontSize="11" fontWeight="700">NURSE STATION</text>
                <text x="600" y="340" textAnchor="middle" fill="#64748b" fontSize="10">Staff Assistance</text>
                <circle cx="600" cy="370" r="14" fill="#334155" />
                <text x="600" y="375" textAnchor="middle" fill="#38bdf8" fontSize="14">⚕️</text>
              </g>

              {/* Rooms Render */}
              {roomsLayout.map(r => {
                const isTarget = r.id === activeRoom.id;
                return (
                  <g key={r.id}>
                    {/* Room Rectangle */}
                    <rect
                      x={r.x}
                      y={r.y}
                      width={r.w}
                      height={r.h}
                      rx="14"
                      fill={isTarget ? '#064e3b' : '#1e293b'}
                      stroke={isTarget ? '#10b981' : '#334155'}
                      strokeWidth={isTarget ? '3' : '1.5'}
                      filter={isTarget ? 'url(#glow)' : undefined}
                    />

                    {/* Room Header Banner */}
                    <rect
                      x={r.x + 10}
                      y={r.y + 10}
                      width={r.w - 20}
                      height="34"
                      rx="8"
                      fill={isTarget ? '#047857' : '#0f172a'}
                    />
                    <text
                      x={r.x + r.w / 2}
                      y={r.y + 32}
                      textAnchor="middle"
                      fill={isTarget ? '#ffffff' : '#e2e8f0'}
                      fontSize="13"
                      fontWeight="800"
                    >
                      {r.label}
                    </text>

                    {/* Target Room Details Badge */}
                    {isTarget ? (
                      <g>
                        <rect x={r.x + 14} y={r.y + 54} width={r.w - 28} height="48" rx="8" fill="#022c22" stroke="#059669" strokeWidth="1" />
                        <text x={r.x + r.w / 2} y={r.y + 72} textAnchor="middle" fill="#34d399" fontSize="11" fontWeight="700">
                          {patient.name}
                        </text>
                        <text x={r.x + r.w / 2} y={r.y + 88} textAnchor="middle" fill="#a7f3d0" fontSize="9">
                          {patient.city ? `[${patient.city}]` : (patient.department || 'Admitted')}
                        </text>

                        {/* Animated Pin */}
                        <g className="pin-bouncing">
                          <circle cx={r.x + r.w / 2} cy={r.y + 118} r="12" fill="#10b981" />
                          <circle cx={r.x + r.w / 2} cy={r.y + 118} r="6" fill="#ffffff" />
                        </g>
                      </g>
                    ) : (
                      <g>
                        <text x={r.x + r.w / 2} y={r.y + 75} textAnchor="middle" fill="#64748b" fontSize="10">
                          {r.type}
                        </text>
                        <text x={r.x + r.w / 2} y={r.y + 98} textAnchor="middle" fill="#475569" fontSize="9">
                          Occupied
                        </text>
                      </g>
                    )}

                    {/* Room Doorway Indicator */}
                    <rect
                      x={r.doorX - 18}
                      y={r.doorY - 5}
                      width="36"
                      height="10"
                      rx="3"
                      fill={isTarget ? '#10b981' : '#475569'}
                    />
                  </g>
                );
              })}

              {/* Animated Walking Route Path */}
              <path
                d={pathD}
                fill="none"
                stroke="#10b981"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="walking-route"
                markerEnd="url(#arrow)"
              />

              {/* Start Point Pulse */}
              <circle cx={startX} cy={startY} r="8" fill="#38bdf8">
                <animate attributeName="r" values="6;11;6" dur="1.5s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.9;0.3;0.9" dur="1.5s" repeatCount="indefinite" />
              </circle>
            </svg>
          </div>
        </div>

        {/* Step-by-Step Wayfinding Instructions */}
        <div style={{ padding: '20px 24px', background: '#ffffff', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Footprints size={18} style={{ color: '#0f766e' }} /> Step-by-Step Wayfinding Guide
          </h3>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
            <div style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: '12px', border: '1px solid #e2e8f0', display: 'flex', gap: '10px' }}>
              <span style={{ width: '28px', height: '28px', borderRadius: '8px', background: '#e0f2fe', color: '#0284c7', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: '0.85rem' }}>1</span>
              <div>
                <b style={{ fontSize: '0.85rem', color: '#0f172a' }}>Take Lift / Elevator</b>
                <p style={{ margin: 0, fontSize: '0.78rem', color: '#64748b' }}>Proceed to <b>Floor {patient.floor}</b></p>
              </div>
            </div>

            <div style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: '12px', border: '1px solid #e2e8f0', display: 'flex', gap: '10px' }}>
              <span style={{ width: '28px', height: '28px', borderRadius: '8px', background: '#fef3c7', color: '#d97706', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: '0.85rem' }}>2</span>
              <div>
                <b style={{ fontSize: '0.85rem', color: '#0f172a' }}>Follow Central Hallway</b>
                <p style={{ margin: 0, fontSize: '0.78rem', color: '#64748b' }}>Exit Lift and walk straight down corridor (~15m)</p>
              </div>
            </div>

            <div style={{ padding: '12px 14px', background: '#f0fdf4', borderRadius: '12px', border: '1px solid #bbf7d0', display: 'flex', gap: '10px' }}>
              <span style={{ width: '28px', height: '28px', borderRadius: '8px', background: '#dcfce7', color: '#16a34a', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: '0.85rem' }}>3</span>
              <div>
                <b style={{ fontSize: '0.85rem', color: '#15803d' }}>Reach Room {patient.room}</b>
                <p style={{ margin: 0, fontSize: '0.78rem', color: '#166534' }}>Room is on your <b>{activeRoom.side}</b> side</p>
              </div>
            </div>
          </div>

          {/* Action Footer */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginTop: '10px', paddingTop: '14px', borderTop: '1px solid #e2e8f0' }}>
            <button 
              type="button" 
              className="btn secondary" 
              onClick={onClose}
              style={{ padding: '10px 24px', fontSize: '13px', fontWeight: 650 }}
            >
              Close Map
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
