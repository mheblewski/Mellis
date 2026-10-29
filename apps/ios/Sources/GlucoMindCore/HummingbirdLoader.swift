import SwiftUI

// MARK: - The hummingbird
//
// The logo's three feathers are not three wings: they are one wing caught at three moments, like a stroboscopic
// photograph (Marey, Muybridge). The motion uses them that way. The top feather is the wing now; the two below it are
// the wing a moment earlier. How far they fan out follows the wing's speed: at the turn of a stroke (where a real
// wing is still for an instant) they close into one sharp wing, at mid-stroke they spread, trailing above the wing on
// the downstroke and below it on the upstroke. The logo itself is the upstroke frozen. Around that: the tip draws a
// figure of eight, the wing flips over edge-on at each turn, the stroke leaves a faint haze, and the feathers are
// flexible, their tips lagging behind the stroke and whipping through at the turn.
//
// The body is not one rigid shape: its outline is rigged on three bones (head, torso, tail), each point of the
// outline weighted to them with soft joints at the neck and the base of the tail, so the bird bends instead of
// turning as a cut-out. The head is gimbal-steady: it counters the body's tilt so the beak holds its line, and it
// moves in quick glances (up, down at the name, back to the drop), as birds' heads do. The neck reaches to drink and
// the tongue laps at the drop. The tail is rudder and counterweight: it swings against the body's lean, fans when the
// bird brakes, pumps in the hover and kicks at take-off. The eye blinks. In the greeting every bone returns to rest
// for the logo pose.

/// A vector outline whose points can be moved one by one: the rig bends the bird by mapping them.
struct VectorPath {
    enum Segment {
        case move(CGPoint)
        case curve(CGPoint, CGPoint, CGPoint)
        case quad(CGPoint, CGPoint)
        case close
    }

    let segments: [Segment]

    init(_ segments: [Segment]) {
        self.segments = segments
    }

    func path(_ map: (CGPoint) -> CGPoint) -> Path {
        var p = Path()
        add(to: &p, map)
        return p
    }

    func add(to p: inout Path, _ map: (CGPoint) -> CGPoint) {
        for segment in segments {
            switch segment {
            case .move(let a): p.move(to: map(a))
            case .curve(let c1, let c2, let a): p.addCurve(to: map(a), control1: map(c1), control2: map(c2))
            case .quad(let c, let a): p.addQuadCurve(to: map(a), control: map(c))
            case .close: p.closeSubpath()
            }
        }
    }
}

/// The bones' positions in one frame; all zero (and the eye open, the tail closed) is the logo.
struct HummingbirdRig {
    /// The head's turn around the neck, degrees (clockwise lifts the beak).
    var headAngle = 0.0
    /// How far the neck stretches the head along the beak, in units.
    var headReach: CGFloat = 0
    /// The tail's turn around its base, degrees (clockwise tucks it forward).
    var tailAngle = 0.0
    /// The tail's spread across its length: 1 = as drawn.
    var tailFan: CGFloat = 1
    /// 1 = eye open, 0 = shut.
    var eyeOpen: CGFloat = 1
    /// The tongue out of the beak, 0...1.
    var tongue: CGFloat = 0
    /// Each feather's bend at its tip, degrees (the tip lagging behind the stroke).
    var featherBend: [Double] = [0, 0, 0]
}

/// The bird's parts in the 256 × 256 box of docs/brand/final/bird.svg.
enum HummingbirdShape {
    /// The point the feathers meet at, which the wing turns around.
    static let shoulder = CGPoint(x: 159, y: 140)
    /// The head: the steady point the whole bird turns and scales around.
    static let head = CGPoint(x: 112, y: 82)
    /// The joints: the head turns around the neck, the tail around its base.
    static let neck = CGPoint(x: 120, y: 100)
    static let tailBase = CGPoint(x: 166, y: 178)
    /// From each joint towards its bone's end (unit vectors).
    static let headAxis = CGVector(dx: -0.16, dy: -0.99)
    static let tailAxis = CGVector(dx: 0.535, dy: 0.845)
    static let eyeCentre = CGPoint(x: 116.86, y: 80.8)
    static let beakTip = CGPoint(x: 45.48, y: 46.4)
    /// The longest feather's length from the shoulder: bends grow with the distance along it.
    static let featherLength: CGFloat = 132
    /// The body and the wing in bird.svg's colours, and bird-on-dark.svg's in dark mode (where the petrol body would
    /// melt into the wing and the strobe would not read).
    static let bodyColor = Brand.dynamic(light: 0x0E5A61, dark: 0xE6FFFA)
    static let wingColor = Brand.dynamic(light: 0x14B8A6, dark: 0x2DD4BF)
    /// The glint on the drop: a lighter amber that still shows on white, near-white on dark.
    static let sparkleColor = Brand.dynamic(light: 0xFFC766, dark: 0xFFF1D0)
    /// The amber drop.
    static let drop = CGPoint(x: 32.58, y: 36.94)
    static let dropRadius: CGFloat = 7.4
    /// The beak's direction (head to tip): sips go along it, the exit dart too.
    static let beak = CGVector(dx: -0.9, dy: -0.43)
    /// Each feather's angle below the top one in the logo, in degrees (clockwise, as on screen).
    static let featherOffsets: [Double] = [0, 13.6, 27.3]
    /// Each feather's direction from the shoulder to its tip, in degrees (as on screen, y down).
    static let featherDirections: [Double] = [-53.1, -39.5, -25.8]

    // MARK: Rig

    /// A point of the body moved by the bones: the torso stays, the head and tail points follow their bone by their
    /// weight, which fades over the neck and the tail's base so the body bends there.
    static func deform(_ p: CGPoint, _ rig: HummingbirdRig) -> CGPoint {
        var out = p
        let toNeck = CGVector(dx: p.x - neck.x, dy: p.y - neck.y)
        let headWeight = CGFloat(HummingbirdChoreography.smooth(Double((toNeck.dx * headAxis.dx + toNeck.dy * headAxis.dy + 8) / 16)))
        if headWeight > 0, rig.headAngle != 0 || rig.headReach != 0 {
            let moved = rotate(p, around: neck, by: rig.headAngle)
            out.x += headWeight * (moved.x - p.x + beak.dx * rig.headReach)
            out.y += headWeight * (moved.y - p.y + beak.dy * rig.headReach)
        }
        let toTail = CGVector(dx: p.x - tailBase.x, dy: p.y - tailBase.y)
        let along = toTail.dx * tailAxis.dx + toTail.dy * tailAxis.dy
        let tailWeight = CGFloat(HummingbirdChoreography.smooth(Double((along + 6) / 18)))
        if tailWeight > 0, rig.tailAngle != 0 || rig.tailFan != 1 {
            // Fanning spreads the tips across the tail's axis; then the whole tail turns at its base.
            let across = toTail.dx * tailAxis.dy - toTail.dy * tailAxis.dx
            let spread = (rig.tailFan - 1) * across * min(1, max(0, along / 50))
            let fanned = CGPoint(x: p.x + spread * tailAxis.dy, y: p.y - spread * tailAxis.dx)
            let moved = rotate(fanned, around: tailBase, by: rig.tailAngle)
            out.x += tailWeight * (moved.x - p.x)
            out.y += tailWeight * (moved.y - p.y)
        }
        return out
    }

    /// An eye point: the lids close towards the eye's middle line, then the head carries it.
    static func deformEye(_ p: CGPoint, _ rig: HummingbirdRig) -> CGPoint {
        let lid = max(0.12, rig.eyeOpen)
        return deform(CGPoint(x: p.x, y: eyeCentre.y + (p.y - eyeCentre.y) * lid), rig)
    }

    /// A feather point bent around the shoulder, more the further out it is: a flexible feather, not a blade.
    static func bend(_ p: CGPoint, by degrees: Double) -> CGPoint {
        guard degrees != 0 else { return p }
        let r = hypot(p.x - shoulder.x, p.y - shoulder.y) / featherLength
        return rotate(p, around: shoulder, by: degrees * Double(r * r))
    }

    static func rotate(_ p: CGPoint, around o: CGPoint, by degrees: Double) -> CGPoint {
        guard degrees != 0 else { return p }
        let a = degrees * .pi / 180
        let (s, c) = (CGFloat(sin(a)), CGFloat(cos(a)))
        let dx = p.x - o.x, dy = p.y - o.y
        return CGPoint(x: o.x + dx * c - dy * s, y: o.y + dx * s + dy * c)
    }

    // MARK: Outlines

    private static func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }

    /// The body, tail and head (the eye is cut out of it).
    static let outline = VectorPath([
        .move(pt(45.48, 46.4)),
        .curve(pt(59.91, 55.77), pt(72.33, 58.53), pt(86.76, 67.9)),
        .curve(pt(94.47, 72.91), pt(98.48, 71.62), pt(104.79, 69.59)),
        .curve(pt(109.11, 68.2), pt(114.5, 66.47), pt(122.88, 66.18)),
        .curve(pt(132.61, 65.84), pt(135.06, 76), pt(137.9, 87.77)),
        .curve(pt(138.57, 90.56), pt(139.26, 93.43), pt(140.08, 96.28)),
        .curve(pt(142.67, 105.31), pt(147.76, 115.77), pt(154.02, 126.68)),
        .quad(pt(153.89, 129.46), pt(153.89, 132.29)),
        .quad(pt(153.89, 136.52), pt(154.22, 140.72)),
        .quad(pt(154.16, 141.55), pt(154.4, 142.39)),
        .quad(pt(154.95, 144.27), pt(156.66, 145.22)),
        .quad(pt(157.94, 145.93), pt(159.3, 145.81)),
        .quad(pt(159.94, 145.77), pt(160.55, 145.54)),
        .quad(pt(162.67, 144.93), pt(164.78, 144.28)),
        .curve(pt(176.06, 161.85), pt(188.5, 179.26), pt(196.84, 192.6)),
        .curve(pt(201.4, 199.89), pt(203.97, 213.75), pt(207.16, 223.56)),
        .curve(pt(207.16, 223.56), pt(196.71, 213.63), pt(191.68, 208.94)),
        .curve(pt(191.68, 208.94), pt(181.55, 220.17), pt(177.92, 227)),
        .curve(pt(177.92, 227), pt(168.39, 198.68), pt(155.56, 190.02)),
        .curve(pt(134.17, 175.59), pt(104.59, 157.92), pt(100.52, 128.96)),
        .curve(pt(99.44, 121.29), pt(99.61, 114.31), pt(99.76, 108.1)),
        .curve(pt(100.03, 96.39), pt(100.25, 87.41), pt(91.92, 81.66)),
        .curve(pt(70.68, 67.01), pt(45.48, 46.4), pt(45.48, 46.4)),
        .close
    ])
    static let eye = VectorPath([
        .move(pt(121.5, 80.8)),
        .curve(pt(121.5, 78.24), pt(119.42, 76.16), pt(116.86, 76.16)),
        .curve(pt(114.3, 76.16), pt(112.22, 78.24), pt(112.22, 80.8)),
        .curve(pt(112.22, 83.36), pt(114.3, 85.44), pt(116.86, 85.44)),
        .curve(pt(119.42, 85.44), pt(121.5, 83.36), pt(121.5, 80.8)),
        .close
    ])
    static let feathers: [VectorPath] = [
        VectorPath([
            .move(pt(238.08, 34.63)),
            .curve(pt(218.22, 74.73), pt(191.32, 110.73), pt(158.99, 141.01)),
            .curve(pt(158.75, 138.13), pt(158.62, 135.22), pt(158.62, 132.29)),
            .curve(pt(158.62, 84.16), pt(192.72, 43.99), pt(238.08, 34.63)),
            .close
        ]),
        VectorPath([
            .move(pt(242.32, 71.34)),
            .curve(pt(222.61, 94.96), pt(199.38, 115.55), pt(173.44, 132.29)),
            .quad(pt(199.99, 105.21), pt(220.38, 73.64)),
            .curve(pt(226.63, 72.11), pt(233.15, 71.3), pt(239.87, 71.3)),
            .curve(pt(240.69, 71.3), pt(241.51, 71.31), pt(242.32, 71.34)),
            .close
        ]),
        VectorPath([
            .move(pt(237.33, 102.13)),
            .curve(pt(218.53, 116.16), pt(197.64, 127.55), pt(175.22, 135.76)),
            .quad(pt(199.86, 119.94), pt(220.96, 99.83)),
            .curve(pt(226.62, 99.91), pt(232.1, 100.71), pt(237.33, 102.13)),
            .close
        ])
    ]
}

/// One frame of the bird: where everything is, in the 256 box.
struct HummingbirdPose {
    var bird: CGAffineTransform = .identity
    var birdOpacity: Double = 1
    var rig = HummingbirdRig()
    /// Each feather's own turn around the shoulder, before the bird's transform.
    var feathers: [CGAffineTransform] = Array(repeating: .identity, count: 3)
    var featherOpacity: [Double] = [1, 1, 1]
    /// The haze a beating wing leaves in the eye: the wing at moments spread over the last beat, each very faint.
    var haze: [CGAffineTransform] = []
    var hazeOpacity: Double = 0
    var dropScale: CGFloat = 1
    var dropOpacity: Double = 1
    /// The drop's light: a steady halo, brighter at each touch of the beak.
    var dropGlow: Double = 0
    /// A glint on the drop: a small four-pointed star, 0 (none) to 1 (full).
    var dropSparkle: Double = 0
    /// The hairline ring leaving the drop at the first touch of a sip, 0 (born) to 1 (gone).
    var ripple: Double?
    /// Fading copies of the whole bird a moment earlier: the strobe of a fast dart.
    var echoes: [(pose: HummingbirdPose, opacity: Double)] = []
}

/// The splash's script, as pure maths on the time so any frame can be drawn on its own (and snapshotted).
enum HummingbirdChoreography {
    struct Script {
        /// Fly in at the start (the splash) or be there already (a loader inside a screen).
        var entrance: Bool
        /// Seconds after the start the app was ready and the bird began to leave.
        var leaveAt: Double?
        /// Leave at once without the lock and dart (a notification opens a screen).
        var hurried = false
        var reduceMotion = false
    }

    // The wingbeat. A real one is 50-80 Hz, a blur; at 10 Hz (12 frames a beat on a 120 Hz screen) the strobe fan
    // still reads while the haze carries the "too fast to see". Slower, it flaps like a bigger bird. The downstroke
    // takes 55% of a beat.
    static let beatsPerSecond = 10.0
    static let downstroke = 0.55
    static let strokeCentre = 9.0
    static let strokeAmplitude = 32.0
    /// Wing speed (degrees a second) at which the echoes reach the logo's spread.
    static let spreadSpeed = 2300.0
    static let hazeSamples = 10
    /// How far a feather's tip bends at full stroke speed, degrees; read a moment late, so it whips through the turn.
    static let featherFlex = 12.0
    static let flexLag = 0.015

    // The entrance: a calm approach from close by, slowing smoothly into the hover. A dart from far with a hard stop
    // is true to the bird but reads as a startle on a screen meant to reassure.
    static let arrivalFrom = CGVector(dx: 46, dy: 34)
    static let arrivalStart = 0.05
    static let arrivalDuration = 0.55
    // The sips: the first one, then one every `sipEvery` while the app keeps loading. The body leans in a little and
    // the neck does the rest.
    static let firstSip = 0.6
    static let sipEvery = 2.4
    static let bodySipReach: CGFloat = 4
    static let neckSipReach: CGFloat = 4.5
    /// The beak touches the drop at these moments of a sip: twice, as a feeding bird probes a flower.
    static let sipTouches = [0.1, 0.26]
    /// The head's glances: (moment, angle) in each sip cycle, snapped in 70 ms as birds move their heads: after
    /// drinking, down at the name (with a blink), then up, and back to the drop.
    static let cycleGlances: [(Double, Double)] = [(0, 0), (0.56, -7), (1.3, 5), (2.0, 0)]
    static let cycleBlink = 0.62
    // The leave: no stop, the bird darts straight out of the hover with its wings beating (a hummingbird never
    // freezes in the air).
    static let dartDuration = 0.36
    static var leaveDuration: Double { dartDuration }
    static let hurriedDuration = 0.25

    static func pose(at t: Double, _ s: Script, echoes: Bool = true) -> HummingbirdPose {
        var pose = HummingbirdPose()
        let breath = (1 - cos(2 * .pi * t / 2.4)) / 2
        if s.reduceMotion {
            pose.dropOpacity = 0.8 + 0.2 * breath
            pose.dropGlow = 0.5 * breath
            pose.birdOpacity = s.entrance ? smooth(t / 0.35) : 1
            if let leave = s.leaveAt, t > leave { pose.birdOpacity *= 1 - smooth((t - leave) / 0.3) }
            pose.dropOpacity *= pose.birdOpacity
            pose.dropGlow *= pose.birdOpacity
            return pose
        }

        // The wing and its echoes.
        applyWing(to: &pose, at: t, rest: 0) { wingAngle($0, s) }

        // The body.
        let body = bodyPlace(t, s)
        let p = HummingbirdShape.head
        pose.bird = CGAffineTransform(translationX: p.x + body.offset.dx, y: p.y + body.offset.dy)
            .rotated(by: body.tilt * .pi / 180)
            .scaledBy(x: body.scale, y: body.scale)
            .translatedBy(x: -p.x, y: -p.y)
        pose.birdOpacity = body.opacity

        // The bones: the head and tail act, the eye blinks; all of it goes to rest for the logo.
        let reach = sipReach(t, s)
        let pump = sin(2 * .pi * 1.7 * t + 0.6)
        var rig = pose.rig
        rig.headAngle = (-0.85 * body.tilt + headGlance(t, s))
        rig.headReach = CGFloat(reach) * neckSipReach
        let lap: Double = 0.55 + 0.45 * sin(2 * .pi * 12 * t)
        rig.tongue = CGFloat(max(0, (reach - 0.8) / 0.2) * lap)
        rig.tailAngle = (-1.1 * body.tilt + 4 * pump)
        let fanFromLean: Double = 0.4 * min(1, abs(body.tilt) / 10)
        let fanFromPump: Double = 0.05 * (pump + 1)
        rig.tailFan = 1 + CGFloat((fanFromLean + fanFromPump))
        rig.eyeOpen = CGFloat(1 - blink(t, s))
        if let kick = takeOff(t, s) {
            // The tail kicks down as the bird pushes off.
            rig.tailAngle += 14 * bump(kick / 0.2)
            rig.tailFan += CGFloat(0.35 * bump(kick / 0.2))
        }
        pose.rig = rig

        // The drop condenses first (the bird flies in to it), glows softly, and brightens at each touch of the beak.
        var dropScale = CGFloat(1 + 0.05 * breath)
        if s.entrance { dropScale *= CGFloat(backOut(t / 0.35)) }
        var glow = 0.35 + 0.25 * breath
        if let sip = sipTime(t, s) {
            for touch in sipTouches {
                let b = bump((sip - touch + 0.03) / 0.35)
                dropScale += CGFloat(0.18 * b)
                glow += 0.9 * b
            }
            let ring = (sip - sipTouches[0]) / 0.6
            if ring > 0, ring < 1 { pose.ripple = ring }
        }
        pose.dropScale = max(0, dropScale)
        pose.dropOpacity = dropFade(t, s)
        pose.dropGlow = glow * pose.dropOpacity * (s.entrance ? smooth(t / 0.35) : 1)

        // The dart out leaves strobe copies of the whole bird behind it (not the arrival: it should feel calm).
        if echoes, body.speed > 200, takeOff(t, s) != nil {
            let strength = min(1, (body.speed - 200) / 450)
            pose.echoes = [(0.07, 0.1), (0.035, 0.2)].map { lag, opacity in
                (Self.pose(at: t - lag, s, echoes: false), opacity * Double(strength))
            }
        }
        return pose
    }

    // MARK: A single flap

    /// A greeting: the wings wake up (a few slower, smaller beats building to the hover's rhythm), the bird leans in
    /// and reaches for the drop, and at the touch of the beak the drop glints; it draws back while its beats slow and
    /// shrink one after another until the wing comes to rest in the logo pose, the fan opening as it settles. A real
    /// wing never stops dead, so neither does this one.
    static let flapDuration = 1.25
    static let flapTouch = 0.4
    /// When the beats start to wind down, and how long they take to settle.
    static let greetingWindDown = 0.68
    static let greetingSettle = 0.55

    static func flapPose(at e: Double) -> HummingbirdPose {
        var pose = HummingbirdPose()
        guard e > 0, e < flapDuration else { return pose }
        let rest = greetingWingRest(e)
        applyWing(to: &pose, at: e, rest: rest) { greetingWingAngle($0) }
        let beating = 1 - rest
        let reach = flapReach(e)
        // The body hovers while the wing beats (a tremor and a slow drift, fading with the beats) and leans in to
        // reach, turning around the steady head; the neck does the rest.
        let tilt = 0.7 * stroke(beatsPerSecond * e - 0.2) * beating - 3 * reach
        let drift = CGVector(dx: 0.8 * sin(2 * .pi * e / 1.3) * beating, dy: -1.2 * sin(.pi * min(1, e / 1.1)) * beating)
        let beak = HummingbirdShape.beak
        let head = HummingbirdShape.head
        let dx = beak.dx * bodySipReach * CGFloat(reach) + drift.dx
        let dy = beak.dy * bodySipReach * CGFloat(reach) + drift.dy + CGFloat(0.35 * stroke(beatsPerSecond * e - 0.15) * beating)
        pose.bird = CGAffineTransform(translationX: head.x + dx, y: head.y + dy)
            .rotated(by: tilt * .pi / 180)
            .translatedBy(x: -head.x, y: -head.y)
        pose.rig.headAngle = -0.85 * tilt
        pose.rig.headReach = neckSipReach * CGFloat(reach)
        pose.rig.tongue = CGFloat(bump((e - flapTouch) / 0.12))
        pose.rig.tailAngle = -1.1 * tilt + 2.5 * sin(2 * .pi * 1.7 * e) * beating
        pose.rig.tailFan = 1 + CGFloat(0.1 * beating)
        // The glint, at the touch of the beak.
        let glint = bump((e - flapTouch + 0.03) / 0.4)
        pose.dropSparkle = glint
        pose.dropGlow = 1.1 * glint
        pose.dropScale = 1 + CGFloat(0.1 * glint)
        return pose
    }

    /// The greeting's wing, degrees from the logo pose. The beat's phase is the integral of its frequency, so the
    /// rhythm speeds up and slows down without a jump: it builds from about 40% to the hover's rate in the first
    /// ~0.2 s, and from `greetingWindDown` falls to about a third while the stroke shrinks to nothing.
    private static func greetingWingAngle(_ e: Double) -> Double {
        guard e > 0 else { return 0 }
        let f = beatsPerSecond
        // Waking up: f(e) = f·(1 − 0.6·e^(−e/0.1)).
        let wake = { (x: Double) in f * (x - 0.06 * (1 - exp(-x / 0.1))) }
        let grow = smooth(e / 0.15)
        guard e > greetingWindDown else { return grow * (strokeCentre + strokeAmplitude * stroke(wake(e))) }
        // Winding down: f(l) = f·(1 − 0.65·l/D), so the beats lengthen one after another.
        let l = min(e - greetingWindDown, greetingSettle)
        let phase = wake(greetingWindDown) + f * (l - 0.65 * l * l / (2 * greetingSettle))
        let fade = pow(1 - l / greetingSettle, 2)
        return fade * (strokeCentre + strokeAmplitude * stroke(phase))
    }

    /// 1 = the wing shows the logo's fan, 0 = its strobe follows its speed.
    private static func greetingWingRest(_ e: Double) -> Double {
        if e < greetingWindDown { return 1 - smooth(e / 0.12) }
        return smooth((e - greetingWindDown) / greetingSettle)
    }

    /// 0...1: the beak out to the drop (touching at `flapTouch`), held a moment, drawn back.
    private static func flapReach(_ e: Double) -> Double {
        switch e {
        case ..<0.22: return 0
        case ..<flapTouch: return smooth((e - 0.22) / (flapTouch - 0.22))
        case ..<(flapTouch + 0.1): return 1
        default: return 1 - smooth((e - flapTouch - 0.1) / 0.35)
        }
    }

    /// The wing at a moment, from its angle over time (degrees from the logo pose) and how much it rests in the logo's
    /// fan (1) instead of following its speed (0): the strobe, the figure of eight, the edge-on flip, the flex, the haze.
    static func applyWing(to pose: inout HummingbirdPose, at t: Double, rest: Double, wingAngle: (Double) -> Double) {
        let angle = wingAngle(t)
        let speed = (angle - wingAngle(t - 1 / 240)) * 240
        // Above the wing (the downstroke) the thin echoes stick out of its edge, so they open less and fade more there.
        let rawSpread = max(-0.6, min(1.15, -speed / spreadSpeed))
        let spread = rawSpread + (1 - rawSpread) * rest
        let pace = min(1, abs(speed) / spreadSpeed)
        // The tip draws a figure of eight: the wing reaches out and in twice a beat.
        let span = 1 - 0.08 * pace * (1 - rest) + 0.06 * sin(4 * .pi * beatsPerSecond * t) * (1 - rest)
        // At each turn the wing flips over (pronation, supination) and is seen edge-on for an instant: a thin flash.
        let turning = pow(1 - min(1, abs(speed) / 1400), 2)
        let chord = 1 - 0.5 * turning * (1 - rest)
        for i in 0..<3 {
            let turn = angle + (spread - 1) * HummingbirdShape.featherOffsets[i]
            pose.feathers[i] = featherTransform(i, turn: turn, span: span, chord: chord)
            let fade = rawSpread < 0 ? [0, 0.45, 0.7][i] * min(1, -rawSpread / 0.6) : [0, 0.3, 0.5][i] * min(1, rawSpread)
            pose.featherOpacity[i] = 1 - fade * (1 - rest)
        }
        // The feathers flex: their tips lag behind the stroke, and whip through the turn a moment after the wing.
        let lagged = (wingAngle(t - flexLag) - wingAngle(t - flexLag - 1 / 240)) * 240
        let flex = -max(-1, min(1, lagged / spreadSpeed)) * featherFlex * (1 - rest)
        pose.rig.featherBend = [flex, flex * 0.8, flex * 0.6]
        // The haze: the wing over its last beat. Where the wing slows (the ends of the stroke) the samples bunch up and
        // the haze thickens, as it does in the eye.
        pose.hazeOpacity = 0.05 * (1 - rest)
        if pose.hazeOpacity > 0.002 {
            pose.haze = (0..<hazeSamples).map { k in
                let earlier = t - Double(k) / (Double(hazeSamples) * beatsPerSecond)
                return featherTransform(0, turn: wingAngle(earlier), span: 1, chord: 1)
            }
        }
    }

    /// A feather turned around the shoulder, its length scaled by `span` and its width (across the feather) by `chord`.
    static func featherTransform(_ i: Int, turn: Double, span: Double, chord: Double) -> CGAffineTransform {
        let o = HummingbirdShape.shoulder
        let axis = HummingbirdShape.featherDirections[i] * .pi / 180
        return CGAffineTransform(translationX: o.x, y: o.y)
            .rotated(by: turn * .pi / 180)
            .rotated(by: axis)
            .scaledBy(x: span, y: chord)
            .rotated(by: -axis)
            .translatedBy(x: -o.x, y: -o.y)
    }

    // MARK: Wing

    /// -1 = wing up, +1 = wing down; slow at both turns, as a real wing.
    static func stroke(_ phase: Double) -> Double {
        let p = phase - floor(phase)
        return p < downstroke ? -cos(.pi * p / downstroke) : cos(.pi * (p - downstroke) / (1 - downstroke))
    }

    /// The wing's turn from the logo pose, in degrees (clockwise = down).
    static func wingAngle(_ t: Double, _ s: Script) -> Double {
        let hover = strokeCentre + strokeAmplitude * stroke(beatsPerSecond * t)
        guard let leave = s.leaveAt, t > leave, !s.hurried else { return hover }
        // Taking off the beat quickens and widens a little, without a break in its rhythm.
        let l = t - leave
        let phase = beatsPerSecond * (leave + 1.3 * l)
        return strokeCentre + (strokeAmplitude + 4 * smooth(l / 0.1)) * stroke(phase)
    }

    // MARK: Acting

    /// Seconds into the take-off, or nil before it.
    static func takeOff(_ t: Double, _ s: Script) -> Double? {
        guard let leave = s.leaveAt, !s.hurried, t > leave else { return nil }
        return t - leave
    }

    /// The head's own turn (on top of keeping level), in quick glances.
    static func headGlance(_ t: Double, _ s: Script) -> Double {
        guard t >= firstSip else { return 0 }
        let keys = cycleGlances
        let moment = (t - firstSip).truncatingRemainder(dividingBy: sipEvery)
        var angle = keys[0].1
        for k in 1..<keys.count {
            angle += (keys[k].1 - keys[k - 1].1) * smooth((moment - keys[k].0) / 0.07)
        }
        return angle
    }

    /// 0 = eye open, 1 = shut: a quick blink with each glance down at the name.
    static func blink(_ t: Double, _ s: Script) -> Double {
        guard t >= firstSip else { return 0 }
        return bump(((t - firstSip).truncatingRemainder(dividingBy: sipEvery) - cycleBlink) / 0.13)
    }

    // MARK: Body

    struct BodyPlace {
        var offset = CGVector.zero
        var tilt = 0.0
        var scale: CGFloat = 1
        var opacity = 1.0
        var speed: CGFloat = 0
    }

    static func bodyPlace(_ t: Double, _ s: Script) -> BodyPlace {
        var place = hoverPlace(t, s)
        // How fast it moves (units a second), for the echoes and the lean.
        let before = hoverPlace(t - 1 / 120, s)
        let vx = (place.offset.dx - before.offset.dx) * 120
        let vy = (place.offset.dy - before.offset.dy) * 120
        place.speed = sqrt(vx * vx + vy * vy)
        // Leaning into the flight, nose up when braking; the body swings around the steady head.
        place.tilt += max(-8, min(8, Double(vx) * 0.03))
        return place
    }

    /// 0...1: how far into the drop the beak is during a sip (two probes, then backing out).
    static func sipReach(_ t: Double, _ s: Script) -> Double {
        guard let sip = sipTime(t, s) else { return 0 }
        // A sip still going when the bird leaves lets go of the drop at once.
        var letGo = 1.0
        if let leave = s.leaveAt, t > leave { letGo = 1 - smooth((t - leave) / 0.1) }
        // In fast, a short second probe, still while drinking, out fast.
        switch sip {
        case ..<0.1: return letGo * easeOut(sip / 0.1)
        case ..<0.26: return letGo * (1 - 0.4 * bump((sip - 0.1) / 0.16))
        case ..<0.34: return letGo
        default: return letGo * (1 - smooth((sip - 0.34) / 0.16))
        }
    }

    /// Everything but the lean. The head is the steady point (a hummingbird holds its head still as a gimbal holds a
    /// camera): the drift moves it little, the wingbeat's tremor only swings the body and tail around it.
    private static func hoverPlace(_ t: Double, _ s: Script) -> BodyPlace {
        var place = BodyPlace()
        var hover = CGVector(
            dx: CGFloat(1.4 * sin(2 * .pi * t / 2.7)),
            dy: CGFloat(1.8 * sin(2 * .pi * t / 1.9 + 0.7) + 0.3 * stroke(beatsPerSecond * t - 0.15))
        )
        place.tilt = 0.8 * stroke(beatsPerSecond * t - 0.2) + 1.2 * sin(2 * .pi * t / 3.1)
        let reach = sipReach(t, s)
        hover.dx += HummingbirdShape.beak.dx * bodySipReach * CGFloat(reach)
        hover.dy += HummingbirdShape.beak.dy * bodySipReach * CGFloat(reach)
        place.tilt -= 2 * reach
        place.offset = hover

        if s.entrance {
            // Coming in from behind and below on a gentle curve (it rises a little sooner than it crosses), easing
            // into the hover with no overshoot.
            let progress = (t - arrivalStart) / arrivalDuration
            let across = CGFloat(easeOutQuint(progress))
            let climb = CGFloat(easeOutQuint(1.2 * progress))
            place.offset.dx += arrivalFrom.dx * (1 - across)
            place.offset.dy += arrivalFrom.dy * (1 - climb)
            place.scale = 0.94 + 0.06 * across
            place.opacity = smooth((t - arrivalStart) / 0.3)
        }

        guard let leave = s.leaveAt, t > leave else { return place }
        let l = t - leave
        if s.hurried {
            place.opacity *= 1 - smooth(l / hurriedDuration)
            return place
        }
        // The dart, straight out of the hover: a hair backwards, then away along the beak, curving up.
        let e = l
        let back = CGFloat(e < 0.05 ? sin(.pi / 2 * e / 0.05) : 1 - smooth((e - 0.05) / 0.06))
        let dart = CGFloat(pow(min(1, max(0, (e - 0.04) / (dartDuration - 0.04))), 2.4))
        place.offset.dx += -HummingbirdShape.beak.dx * 5 * back + HummingbirdShape.beak.dx * 470 * dart
        place.offset.dy += -HummingbirdShape.beak.dy * 5 * back + HummingbirdShape.beak.dy * 470 * dart - 70 * dart * dart
        place.scale *= 1 - 0.4 * dart
        place.opacity *= 1 - smooth((e - 0.14) / 0.2)
        return place
    }

    /// Seconds into the current sip, or nil between sips and once the bird is leaving.
    static func sipTime(_ t: Double, _ s: Script) -> Double? {
        guard t >= firstSip else { return nil }
        let local = (t - firstSip).truncatingRemainder(dividingBy: sipEvery)
        guard local < 0.8 else { return nil }
        if let leave = s.leaveAt, t - local > leave { return nil }
        return local
    }

    static func dropFade(_ t: Double, _ s: Script) -> Double {
        guard let leave = s.leaveAt, t > leave else { return 1 }
        let l = t - leave
        if s.hurried { return 1 - smooth(l / hurriedDuration) }
        return 1 - smooth((l - 0.06) / 0.22)
    }

    // MARK: Curves

    static func smooth(_ x: Double) -> Double {
        let t = min(max(x, 0), 1)
        return t * t * (3 - 2 * t)
    }

    static func easeOut(_ x: Double) -> Double {
        let t = min(max(x, 0), 1)
        return 1 - pow(1 - t, 3)
    }

    /// Eases out past 1 a little and back: a drop condensing, not a spring popping.
    static func backOut(_ x: Double) -> Double {
        let t = min(max(x, 0), 1)
        let c = 0.9
        return 1 + (c + 1) * pow(t - 1, 3) + c * pow(t - 1, 2)
    }

    /// 0 → 1 → 0 over 0...1.
    static func bump(_ x: Double) -> Double {
        guard x > 0, x < 1 else { return 0 }
        return sin(.pi * x)
    }

    /// Fast at first, then a long soft settle with no overshoot.
    static func easeOutQuint(_ x: Double) -> Double {
        let t = min(max(x, 0), 1)
        return 1 - pow(1 - t, 5)
    }
}

// MARK: - Drawing

/// Draws a pose: the echoes first, then the wing's haze and the wing behind the body, then the drop's light, its ring,
/// the drop and the tongue lapping at it.
struct HummingbirdCanvas: View {
    let size: CGFloat
    let pose: HummingbirdPose

    /// How far past the 256 box the bird may be drawn, in its units on every side: the wing's downstroke and haze, the
    /// entrance from the lower right and most of the exit dart leave the box, and a canvas clips to its frame.
    static let margin: CGFloat = 384

    var body: some View {
        // The layout keeps the logo's square; the canvas drawn over it is much larger and is not clipped by it.
        Color.clear
            .frame(width: size, height: size)
            .overlay {
                canvas
                    .frame(width: size * (256 + 2 * Self.margin) / 256, height: size * (256 + 2 * Self.margin) / 256)
                    .allowsHitTesting(false)
            }
    }

    private var canvas: some View {
        Canvas { context, canvasSize in
            let scale = canvasSize.width / (256 + 2 * Self.margin)
            context.scaleBy(x: scale, y: scale)
            context.translateBy(x: Self.margin, y: Self.margin)
            for echo in pose.echoes {
                Self.drawBird(echo.pose, opacity: echo.opacity * echo.pose.birdOpacity, in: &context)
            }
            Self.drawBird(pose, opacity: pose.birdOpacity, in: &context)

            let c = HummingbirdShape.drop
            let amber = Brand.amber
            if pose.dropGlow > 0.01 {
                let r = HummingbirdShape.dropRadius * (2.2 + 0.9 * CGFloat(min(pose.dropGlow, 1.3)))
                context.fill(
                    Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)),
                    with: .radialGradient(
                        Gradient(colors: [amber.opacity(0.32 * min(pose.dropGlow, 1.3)), amber.opacity(0)]),
                        center: c, startRadius: 0, endRadius: r
                    )
                )
            }
            if let ripple = pose.ripple {
                let r = HummingbirdShape.dropRadius + 24 * CGFloat(1 - pow(1 - ripple, 3))
                context.stroke(
                    Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)),
                    with: .color(amber.opacity(0.45 * pow(1 - ripple, 2) * pose.dropOpacity)),
                    lineWidth: 0.8
                )
            }
            let r = HummingbirdShape.dropRadius * pose.dropScale
            context.fill(
                Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)),
                with: .color(amber.opacity(pose.dropOpacity))
            )
            if pose.dropSparkle > 0.01 {
                Self.drawSparkle(pose.dropSparkle, at: c, opacity: pose.dropOpacity, in: &context)
            }
            Self.drawTongue(pose, in: &context)
        }
    }

    private static func drawBird(_ pose: HummingbirdPose, opacity: Double, in context: inout GraphicsContext) {
        guard opacity > 0.001 else { return }
        var layer = context
        layer.opacity = opacity
        let rig = pose.rig
        for sample in pose.haze {
            layer.fill(
                HummingbirdShape.feathers[0].path { $0.applying(sample.concatenating(pose.bird)) },
                with: .color(HummingbirdShape.wingColor.opacity(pose.hazeOpacity))
            )
        }
        // The echoes overlap where the wing is slow: as one layer they read as one wing, not stacked tints.
        layer.drawLayer { wing in
            for i in (0..<3).reversed() {
                let place = pose.feathers[i].concatenating(pose.bird)
                let bend = rig.featherBend[i]
                wing.fill(
                    HummingbirdShape.feathers[i].path { HummingbirdShape.bend($0, by: bend).applying(place) },
                    with: .color(HummingbirdShape.wingColor.opacity(pose.featherOpacity[i]))
                )
            }
        }
        var body = HummingbirdShape.outline.path { HummingbirdShape.deform($0, rig).applying(pose.bird) }
        HummingbirdShape.eye.add(to: &body) { HummingbirdShape.deformEye($0, rig).applying(pose.bird) }
        layer.fill(body, with: .color(HummingbirdShape.bodyColor), style: FillStyle(eoFill: true))
    }

    /// A four-pointed star on the drop's upper right, turning a little as it flares and fades, with a white core.
    private static func drawSparkle(_ amount: Double, at centre: CGPoint, opacity: Double, in context: inout GraphicsContext) {
        let c = CGPoint(x: centre.x + 2.2, y: centre.y - 2.2)
        let arm = HummingbirdShape.dropRadius * CGFloat(0.6 + 2.2 * amount)
        let waist = arm * 0.16
        var star = Path()
        star.move(to: CGPoint(x: 0, y: -arm))
        star.addQuadCurve(to: CGPoint(x: arm, y: 0), control: CGPoint(x: waist, y: -waist))
        star.addQuadCurve(to: CGPoint(x: 0, y: arm), control: CGPoint(x: waist, y: waist))
        star.addQuadCurve(to: CGPoint(x: -arm, y: 0), control: CGPoint(x: -waist, y: waist))
        star.addQuadCurve(to: CGPoint(x: 0, y: -arm), control: CGPoint(x: -waist, y: -waist))
        star.closeSubpath()
        let turn = CGAffineTransform(translationX: c.x, y: c.y).rotated(by: CGFloat(0.35 * amount))
        context.fill(star.applying(turn), with: .color(HummingbirdShape.sparkleColor.opacity(amount * opacity)))
        let core = 1.4 * CGFloat(amount)
        context.fill(
            Path(ellipseIn: CGRect(x: c.x - core, y: c.y - core, width: 2 * core, height: 2 * core)),
            with: .color(.white.opacity(amount * opacity))
        )
    }

    /// The tongue: a fine line out of the beak tip, lapping in and out of the drop.
    private static func drawTongue(_ pose: HummingbirdPose, in context: inout GraphicsContext) {
        guard pose.rig.tongue > 0.02, pose.birdOpacity > 0.01 else { return }
        let tip = HummingbirdShape.beakTip
        let along = CGPoint(x: tip.x + HummingbirdShape.beak.dx, y: tip.y + HummingbirdShape.beak.dy)
        let a = HummingbirdShape.deform(tip, pose.rig).applying(pose.bird)
        let b = HummingbirdShape.deform(along, pose.rig).applying(pose.bird)
        let length = hypot(b.x - a.x, b.y - a.y)
        guard length > 0 else { return }
        let reach = 8 * pose.rig.tongue / length
        var line = Path()
        line.move(to: a)
        line.addLine(to: CGPoint(x: a.x + (b.x - a.x) * reach, y: a.y + (b.y - a.y) * reach))
        context.stroke(
            line,
            with: .color(HummingbirdShape.bodyColor.opacity(0.9 * pose.birdOpacity)),
            style: StrokeStyle(lineWidth: 1.6, lineCap: .round)
        )
    }
}

/// The loader for short waits (the dashboard's first data, the patient list): the system spinner in the wing's teal,
/// centred on the whole screen.
/// The hummingbird is kept for the launch splash and the new conversation's greeting; on screen for a split second it
/// was more distraction than delight.
public struct BrandSpinner: View {
    public init() {}

    public var body: some View {
        ProgressView()
            .controlSize(.large)
            .tint(HummingbirdShape.wingColor)
            .accessibilityLabel("Wczytuję")
            // In the very middle of the screen, where the launch splash's bird was, not of the safe area.
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .ignoresSafeArea()
    }
}

/// The hummingbird logo, drawn live: still as the logo, and greeting (HummingbirdChoreography.flapPose) when tapped.
/// With Reduce Motion on it stays still.
public struct HummingbirdMark: View {
    private let size: CGFloat
    /// When the greeting a tap started began; nil while the logo is still.
    @State private var flapStart: Date?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(size: CGFloat) {
        self.size = size
    }

    public var body: some View {
        Group {
            if let flapStart {
                TimelineView(.animation) { timeline in
                    HummingbirdCanvas(size: size, pose: HummingbirdChoreography.flapPose(at: timeline.date.timeIntervalSince(flapStart)))
                }
            } else {
                HummingbirdCanvas(size: size, pose: HummingbirdPose())
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            // A tap during the greeting lets it finish rather than jump back to the start.
            guard flapStart == nil, !reduceMotion else { return }
            flapStart = Date()
        }
        .accessibilityHidden(true)
        // Only a tap starts the greeting: coming back to the screen (the task runs again on every appearance) plays
        // nothing, it only ends a greeting cut short by leaving.
        .task(id: flapStart) {
            guard let flapStart else { return }
            let left = HummingbirdChoreography.flapDuration + 0.05 - Date().timeIntervalSince(flapStart)
            if left > 0 { try? await Task.sleep(for: .seconds(left)) }
            guard !Task.isCancelled else { return }
            // Back to the still logo: no clock running while nothing moves.
            self.flapStart = nil
        }
    }
}
