const std = @import("std");

pub const Point = struct {
    x: i32,
    y: i32,

    pub fn init(x: i32, y: i32) Point {
        return .{ .x = x, .y = y };
    }

    pub fn distance(self: Point, other: Point) f64 {
        const dx = self.x - other.x;
        const dy = self.y - other.y;
        return @sqrt(@as(f64, @floatFromInt(dx * dx + dy * dy)));
    }
};

pub const Direction = enum {
    north,
    south,
    east,
    west,

    pub fn opposite(self: Direction) Direction {
        return switch (self) {
            .north => .south,
            .south => .north,
            .east => .west,
            .west => .east,
        };
    }
};

pub const ShapeTag = union(enum) {
    circle: f64,
    rectangle: struct { width: f64, height: f64 },

    pub fn area(self: ShapeTag) f64 {
        return switch (self) {
            .circle => |r| std.math.pi * r * r,
            .rectangle => |r| r.width * r.height,
        };
    }
};

fn helper(x: i32) i32 {
    return x * 2;
}

pub fn main() !void {
    const p = Point.init(3, 4);
    const d = helper(p.x);
    const dir = Direction.north;
    _ = dir.opposite();
    _ = d;
}

test "Point init" {
    const p = Point.init(1, 2);
    try std.testing.expectEqual(@as(i32, 1), p.x);
    try std.testing.expectEqual(@as(i32, 2), p.y);
}
