let ADDRESSES = {
    'arrows': 0x377,
    'bombs': 0x343,
    'rupees': 0x360, // N.B. this isn't enough to represent higher values of rupees but we don't need to for our purposes 
    'rupee_disp': 0x362,
    'mushroom': 0x344, // 0 none, 1 shroom, 2 powder
    'max_health': 0x36C,
    'current_health': 0x36D, // set this to what player will load in with
    'bug_net': 0x34D,
    'bottle_1': 0x35C,
    'bottle_2': 0x35D,
    'heart_refill' : 0x372,
    'progress_flags': 0x3C9, // see disasm, what we want this for is just setting bottle purchased
    ROOMS: {
        // N.B. low byte, contains ccccqqqq
        'sanc': 0x24,
        'tavern': 0x206,
    }
}

function sixteen_bit(low, high) {
    return low | (high << 8);
}

function calculate_sixteen_bit_sum(bytes, start, stop) {
    var sum = 0;
    for (var i = start; i < stop; i+= 2) {
        sum += sixteen_bit(bytes[i], bytes[i+1]);
    }
    return sum;
}

function sanity_check_save_slot(bytes, offset) {
    // sanity check
    let sum = calculate_sixteen_bit_sum(
        bytes, offset, offset + 0x4FE
    );
    let checksum = sixteen_bit(
        bytes[offset + 0x3E1], bytes[offset + 0x3E2]
    );
    if (checksum !== 0x55AA) {
        console.log("got bad static", checksum);
        return false;
    }
    let inverse_checksum = sixteen_bit(bytes[offset + 0x4FE], bytes[offset + 0x4FF]);
    let total = (inverse_checksum + sum) & 0xFFFF;
    if (total != 0x5A5A) {
        console.log("got bad inverse checksum");
        return false;
    }
    let expected = calculate_checksum(bytes, offset);
    if ( expected != inverse_checksum) {
        console.log("your bad at math: calculated ", expected, "actual", inverse_checksum);
    }
    return true;
}

function calculate_checksum(bytes, offset) {
    let sum = calculate_sixteen_bit_sum(
        bytes, offset, offset + 0x4FE
    );
    return (0x15A5A - sum) & 0xFFFF;
}

function alter_slot(bytes, memory_adjustments, offset) {
    console.log('altering: adjustments: ', memory_adjustments);
    for (const [loc, val] of memory_adjustments) {
        bytes[offset + loc] = val;
    }
    let cs = calculate_checksum(bytes, offset);
    bytes[offset + 0x4FE] = cs & 0xFF;
    bytes[offset + 0x4FF] = cs >> 8;
    console.log('altered:', bytes.slice(0, 0x500));
}

function alter_all_slots(bytes, adjustments) {
    for (const offset of [0, 0x500, 0xA00]) {
        alter_slot(bytes, adjustments, offset);
        if (!sanity_check_save_slot(bytes, offset)) {
            console.log('booo');
        }
    }
}

class InputToStuff {
    parse_input;
    validate_value;
    produce_updates;
    constructor(parse_input, validate, produce_updates) {
        this.parse_input = parse_input;
        this.validate = validate;
        this.produce_updates = produce_updates;
    }

    /// input is an <input> element
    generate_updates(input) {
        let value;
        try {
            value = this.parse_input(input);
        } catch (e) {
            return {error: `cannot parse input: ${e}`};
        }
        let valid = this.validate(value);
        if (!valid) {
            return {error: 'input invalid'};
        }
        let updates = this.produce_updates(value);
        if (!updates) {
            return {error: 'unable to produce updates'};
        }
        return updates;
    }

}

let numeric = i => parseInt(i.value, 10);
let checked = i => +i.checked;
let address_to_value = function(name) {
    return function(v) {
        if (ADDRESSES[name] === undefined) {
            return false;
        }
        return [[ADDRESSES[name], v]];
    };
};
let rupee_updates = function(v) {
    return [
        [ADDRESSES['rupees'], v],
        [ADDRESSES['rupee_disp'], v],
    ];
}

let sanc_heart_updates = function(v) {
    let hps = v ? 11 : 10;
    let cur_health;
    // game stores hp as hp*8
    if (hps === 11) {
        cur_health = 11 * 0x8;
    } else {
        cur_health = 10 * 0x8;
    }
    let max_health = hps * 0x8;
    return [
        [ADDRESSES['max_health'], max_health],
        [ADDRESSES.ROOMS['sanc'], 0xFFFF & (v << 4)],
        [ADDRESSES['current_health'], cur_health], 
    ];
}

let refill_updates = function(v) {
    let refill = v ? 0xA0 : 0x0;
    return[[ADDRESSES['heart_refill'], v]];
}

function bottle_value(bottle) {
    return {
        no: 0,
        empty: 2,
        red: 3,
        fairy: 6,
        bee: 7
    }[bottle];
}

let mushroom_updates = function(v) {
    if(v.value === 'mushroom') {
        return [[ADDRESSES['mushroom'], 1]];
    } else if( v.value === 'powder') {
        return [[ADDRESSES['mushroom'], 2]];
    } else {
        return [[ADDRESSES['mushroom'], 0]];
    }
}

function bottle_updates(tavern, vendor) {
    let tavern_state = tavern.value;
    let vendor_state = vendor.value;
    if (tavern_state === 'red' && vendor_state === 'red') {
        return {error: 'Starting with 2 red potions is not allowed.'};
    }
    let tavern_val = bottle_value(tavern_state);
    if (tavern_val === undefined) {
        return {error: 'Invalid value for tavern bottle'};
    }
    let vendor_val = bottle_value(vendor_state);
    if (vendor_val === undefined) {
        return {error: 'Invalid value for vendor bottle'};
    }
    let updates = [];
    let bottle_indexes = [ADDRESSES.bottle_2, ADDRESSES.bottle_1];
    if (tavern_val !== 0) {
        updates.push([bottle_indexes.pop(), tavern_val]);
        // 0x1A = 0b11010 = [chest opened, nw seen, sw seen, sw unseen, se unseen]
        updates.push([ADDRESSES.ROOMS.tavern, 0x1A]);
    }
    if (vendor_val !== 0) {
        updates.push([bottle_indexes.pop(), vendor_val]);
        // bottle purchased from vendor
        // the other flags are illegal to set in this category
        updates.push([ADDRESSES.progress_flags, 0x2]);
    }
    return updates;
}


function form_to_updates(form) {
    let fields = [
        ['arrows', new InputToStuff(
            numeric, a => a >= 0 && a <= 30, address_to_value('arrows')
        )],
        ['bombs', new InputToStuff(
            numeric, a => a >= 0 && a <= 5, address_to_value('bombs')
        )],
        ['rupees', new InputToStuff(
            numeric,  a => a >= 0 && a <= 250, rupee_updates,
        )],
        ['sanc_heart', new InputToStuff(
            checked, () => true, sanc_heart_updates,
        )],
        ['heart_refill', new InputToStuff(
            checked, () => true, refill_updates,
        )],
        ['bug_net', new InputToStuff(
            checked, () => true, address_to_value('bug_net')
        )],
    ];
    var updates = [];
    for (const [f, validator] of fields) {
        let input = form.querySelector(`[name="${f}"]`);
        if (!input) {
            return {'error': `Missing input ${f}`};
        }
        let value = validator.generate_updates(input);
        if (value.error) {
            return {error: `Error with ${f}: ${value.error}`};
        }
        updates = updates.concat(value);
    }
    let mushroom_select = form.querySelector('[name="mushroom"]');
    let m_updates = mushroom_updates(mushroom_select);
    updates = updates.concat(m_updates);
    let bottle_selects = [
        form.querySelector('[name="tavern_bottle"]'),
        form.querySelector('[name="vendor_bottle"]'),
    ];
    let b_updates = bottle_updates(...bottle_selects);
    if (b_updates.error) {
        return b_updates;
    }
    updates = updates.concat(b_updates);
    return updates;
}

document.addEventListener('DOMContentLoaded', async () => {
    let default_save = await fetch('dirtythirty.srm')
        .then(resp => resp.arrayBuffer())
        .then(arr => new Uint8Array(arr))
        .catch(e => {
            console.log("Error fetching srm", e);
        });
    for (let i of [0, 0x500, 0xA00]) {
        if (!sanity_check_save_slot(default_save, i)) {
            console.log("bad checksum");
        }
    }
    console.log(default_save);

    document.querySelector('button').addEventListener('click', () => {
        let form = document.querySelector('form');
        let updates = form_to_updates(form);
        if (updates.error) {
            alert(updates.error);
            return;
        }

        // keep our known good one around
        let save = default_save.slice(0);
        alter_all_slots(save, updates);
        console.log(save);
        let data = new Blob([save]);
        let a = document.createElement('a');
        let url = URL.createObjectURL(data);
        a.href = url;
        a.download = 'dirtythirty.srm';
        a.click();
    });
});

