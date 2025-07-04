import { app } from "../../scripts/app.js";
import { GroupNodeHandler } from "../core/groupNode.js";
import { settingsCache } from "./use_everywhere_cache.js";

class Logger {
    static LIMITED_LOG_BLOCKED = false;
    static LIMITED_LOG_MS      = 5000;
    static level;  // 0 for errors only, 1 activates 'log_problem', 2 activates 'log_info', 3 activates 'log_detail'

    static log_error(message) { console.error(message) }

    static log(message, array, limited) {    
        if (limited && Logger.check_limited()) return
        console.log(message);
        if (array) for (var i=0; i<array.length; i++) { console.log(array[i]) }
    }

    static check_limited() {
        if (Logger.LIMITED_LOG_BLOCKED) return true
        Logger.LIMITED_LOG_BLOCKED = true
        setTimeout( ()=>{Logger.LIMITED_LOG_BLOCKED = false}, Logger.LIMITED_LOG_MS )
        return false
    }

    static null() {}

    static level_changed(new_level) {
        Logger.level = new_level    
        Logger.log_detail  = (Logger.level>=3) ? Logger.log : Logger.null
        Logger.log_info    = (Logger.level>=2) ? Logger.log : Logger.null
        Logger.log_problem = (Logger.level>=1) ? Logger.log : Logger.null
    }

    static log_detail(){}
    static log_info(){}
    static log_problem(){}
}

Logger.level_changed(settingsCache.getSettingValue('Use Everywhere.Options.logging'))
settingsCache.addCallback('Use Everywhere.Options.logging', Logger.level_changed)

class GraphConverter {
    static _instance;
    static instance() {
        if (!GraphConverter._instance) GraphConverter._instance = new GraphConverter();
        return GraphConverter._instance;
    }

    constructor() { 
        this.node_input_map = {};
        this.given_message = false;
        this.did_conversion = false;
        this.graph_being_configured = false;
     }

    running_116_plus() {
        const version = __COMFYUI_FRONTEND_VERSION__.split('.')
        return (parseInt(version[0])>=1 && (parseInt(version[0])>1 || parseInt(version[1])>=16))
    }

    store_node_input_map(data) { 
        this.node_input_map = {};
        data?.nodes.filter((node)=>(node.inputs)).forEach((node) => { this.node_input_map[node.id] = node.inputs.map((input) => input.name); })
        Logger.log_detail("stored node_input_map", this.node_input_map);
    }

    on_node_created(node) {
        if (this.graph_being_configured) {
            /*
            If the graph is being configured, we are still loading old nodes. 
            These might need to be converted, but we can't do that yet
            */
            return;
        }
        
        if (!(node.properties)) node.properties = {};
        if (node.properties.widget_ue_connectable) {
            console.log(`already has widget_ue_connectable`)
            return 
        }
        node.properties['widget_ue_connectable'] = {}
        console.log(`added widget_ue_connectable`)
    }

    clean_ue_node(node) {

        const gpData = GroupNodeHandler.getGroupData(node)
        const isGrp  = !!gpData;
        if (isGrp) {
            let a;
        }
        
        var expected_inputs = 1
        if (node.type == "Seed Everywhere") expected_inputs = 0
        if (node.type == "Prompts Everywhere") expected_inputs = 2
        if (node.type == "Anything Everywhere3") expected_inputs = 3
        if (node.type == "Anything Everywhere?") expected_inputs = 4

        // remove all the 'anything' inputs (because they may be duplicated)
        const removed = node.inputs.filter(i=>i.label=='anything')
        node.inputs   = node.inputs.filter(i=>i.label!='anything') 
        // add them back as required
        while (node.inputs.length < expected_inputs) { node.inputs.push(removed.pop()) }
        // the input comes before the regex widgets in UE?
        if (expected_inputs==4) {
            while(node.inputs[0].name.includes('regex')) {
                node.inputs.unshift(node.inputs.pop()) 
            }
        }
        // fix the localized names
        node.inputs = node.inputs.map((input) => {
            if (input.localized_name=='anything') input.localized_name = input.name
            return input;
        })

        // set types to match
        node.input_type = node.inputs.map((i)=>{
            var type = i.type;
            if (type=='*') {
                if (i.link) type = app.graph.links[i.link].type;
                else type = (i.label && i.label!='anything') ? i.label : i.name;      
            }
            return type
        })

        Logger.log_detail(`clean_ue_node ${node.id} (${node.type})`, node.inputs, node.input_type);
    }

    convert_if_pre_116(node) {
        if (!node) return;
        if (!(node.properties)) node.properties = {};

        if (node.IS_UE) this.clean_ue_node(node)
        
        if (node.properties.widget_ue_connectable) return

        if (!this.given_message) {
            Logger.log_info(`Graph was saved with a version of ComfyUI before 1.16, so Anything Everywhere will try to work out which widgets are connectable`);
            this.given_message = true;
        }

        node.properties['widget_ue_connectable'] = {}
        const widget_names = node.widgets?.map(w => w.name) || [];

        if (!(this.node_input_map[node.id])) {
            Logger.log_detail(`node ${node.id} (${node.type} has no node_input_map`);
        } else {
            this.node_input_map[node.id].filter((input_name)=>widget_names.includes(input_name)).forEach((input_name) => {
                node.properties['widget_ue_connectable'][input_name] = true;
                this.did_conversion = true;
                Logger.log_info(`node ${node.id} widget ${input_name} marked as accepting UE because it was an input when saved`);
            });
        }


        
        //node.properties.ue116converted = true;
    }

    remove_saved_ue_links() {
        if (app.graph.extra?.links_added_by_ue) {
            app.graph.extra.links_added_by_ue.forEach((link) => { app.graph.links.delete(link); })
        }
    }
}

export const graphConverter = GraphConverter.instance();

class LoopError extends Error {
    constructor(id, stack, ues) {
        super("Loop detected");
        this.id = id;
        this.stack = [...stack];
        this.ues = [...ues];
    }
}

function find_all_upstream(node_id, links_added) {
    const all_upstream = [];
    const node = get_real_node(node_id);
    node?.inputs?.forEach((input) => { // normal links
        const link_id = input.link;
        if (link_id) {
            const link = app.graph.links[link_id];
            if (link) all_upstream.push({id:link.origin_id, slot:link.origin_slot});
        }
    });
    links_added.forEach((la)=>{ // UE links
        if (get_real_node(la.downstream).id==node.id) {
            all_upstream.push({id:la.upstream, slot:la.upstream_slot, ue:la.controller.toString()})
        }
    });
    if (node.id != get_group_node(node.id).id) { // node is in group
        const grp_nd = get_group_node(node.id).id;
        const group_data = GroupNodeHandler.getGroupData(get_group_node(node.id));
        const indx = group_data.nodeData.nodes.findIndex((n)=>n.pos[0]==node.pos[0] && n.pos[1]==node.pos[1]);
        if (indx>=0) {
            if (GroupNodeHandler.getGroupData(app.graph._nodes_by_id[grp_nd])?.linksTo?.[indx] ) { // links within group
                Object.values(GroupNodeHandler.getGroupData(app.graph._nodes_by_id[grp_nd]).linksTo[indx]).forEach((internal_link) => {
                    all_upstream.push({id:`${grp_nd}:${internal_link[0]}`, slot:internal_link[1]});
                });
            }
            if (GroupNodeHandler.getGroupData(app.graph._nodes_by_id[grp_nd]).oldToNewInputMap?.[indx]) { // links out of group
                Object.values(GroupNodeHandler.getGroupData(app.graph._nodes_by_id[grp_nd]).oldToNewInputMap?.[indx]).forEach((groupInput) => {
                    const link_id = get_group_node(node.id).inputs?.[groupInput]?.link;
                    if (link_id) {
                        const link = app.graph.links[link_id];
                        if (link) all_upstream.push({id:link.origin_id, slot:link.origin_slot});
                    }
                })
            }
        }
    }
    return all_upstream;
}

function recursive_follow(node_id, start_node_id, links_added, stack, nodes_cleared, ues, count, slot) {
    const node = get_real_node(node_id);
    if (slot>=0 && GroupNodeHandler.isGroupNode(node)) { // link into group
        const mapped = GroupNodeHandler.getGroupData(node).newToOldOutputMap[slot];
        return recursive_follow(`${node.id}:${mapped.node.index}`, start_node_id, links_added, stack, nodes_cleared, ues, count, mapped.slot);
    }
    count += 1;
    if (stack.includes(node.id.toString())) throw new LoopError(node.id, new Set(stack), new Set(ues));
    if (nodes_cleared.has(node.id.toString())) return;
    stack.push(node.id.toString());

    find_all_upstream(node.id, links_added).forEach((upstream) => {
        if (upstream.ue) ues.push(upstream.ue);
        count = recursive_follow(upstream.id, start_node_id, links_added, stack, nodes_cleared, ues, count, upstream.slot);
        if (upstream.ue) ues.pop();
    })

    nodes_cleared.add(node.id.toString());
    stack.pop();
    return count;
}

/*
Throw a LoopError if there is a loop.
live_nodes is a list of all live (ie not bypassed) nodes in the graph
links_added is a list of the UE virtuals links 
*/
function node_in_loop(live_nodes, links_added) {
    var nodes_to_check = [];
    const nodes_cleared = new Set();
    live_nodes.forEach((n)=>nodes_to_check.push(get_real_node(n.id).id));
    var count = 0;
    while (nodes_to_check.length>0) {
        const node_id = nodes_to_check.pop();
        count += recursive_follow(node_id, node_id, links_added, [], nodes_cleared, [], 0, -1);
        nodes_to_check = nodes_to_check.filter((nid)=>!nodes_cleared.has(nid.toString()));
    }
    console.log(`node_in_loop made ${count} checks`)
}

/*
Is a node alive (ie not bypassed or set to never)
*/
function node_is_live(node, treat_bypassed_as_live){
    if (!node) return false;
    if (node.mode===0) return true;
    if (node.mode===2 || node.mode===4) return !!treat_bypassed_as_live;
    Logger.log_error(`node ${node.id} has mode ${node.mode} - I only understand modes 0, 2 and 4`);
    return true;
}

function node_is_bypassed(node) {
    return (node.mode===4);
}

/*
Given a link object, and the type of the link,
go upstream, following links with the same type, until you find a parent node which isn't bypassed.
If either type or original link is null, or if the upstream thread ends, return null
*/
function handle_bypass(original_link, type) {
    if (!type || !original_link) return null;
    var link = original_link;
    var parent = get_real_node(link.origin_id);
    if (!parent) return null;
    while (node_is_bypassed(parent)) {
        if (!parent.inputs) return null;
        var link_id;
        if (parent?.inputs[link.origin_slot]?.type == type) link_id = parent.inputs[link.origin_slot].link; // try matching number first
        else link_id = parent.inputs.find((input)=>input.type==type)?.link;
        if (!link_id) { return null; }
        link = app.graph.links[link_id];
        parent = get_real_node(link.origin_id);
    }
    return link;
}

function all_group_nodes() {
    return app.graph._nodes.filter((node) => GroupNodeHandler.isGroupNode(node));
}

function is_in_group(node_id, group_node) {
    return group_node.getInnerNodes().find((inner_node) => (inner_node.id==node_id));
}

/*
Return the group node if this node_id is part of a group, else return the node itself.
Returns a full node object
*/
function get_group_node(node_id) {
    const nid = node_id.toString();
    var gn = app.graph._nodes_by_id[nid];
    if (!gn && nid.includes(':')) gn = app.graph._nodes_by_id[nid.split(':')[0]];
    if (!gn) gn = all_group_nodes().find((group_node) => is_in_group(nid, group_node));
    if (!gn) Logger.log_error(`get_group node couldn't find ${nid}`)
    return gn;
}

/*
Return the node object for this node_id. 
- if it's in _nodes_by_id return it
- if it is of the form x:y find it in group node x
- if it is the real node number of something in a group, get it from the group
*/
function get_real_node(node_id) {
    const nid = node_id.toString();
    var rn = app.graph._nodes_by_id[nid];
    if (!rn && nid.includes(':')) rn = app.graph._nodes_by_id[nid.split(':')[0]]?.getInnerNodes()[nid.split(':')[1]]
    if (!rn) {
        all_group_nodes().forEach((node) => {
            if (!rn) rn = node.getInnerNodes().find((inner_node) => (inner_node.id==nid));
        })
    }
    if (!rn) Logger.log_info(`get_real_node couldn't find ${node_id} - ok during loading, shortly after node deletion etc.`)
    return rn;
}

function get_all_nodes_within(node_id) {
    const node = get_group_node(node_id);
    if (GroupNodeHandler.isGroupNode(node)) return node.getInnerNodes();
    return [];
}


/*
Does this input connect upstream to a live node?
*/
function is_connected(input, treat_bypassed_as_live) {
    const link_id = input.link;
    if (link_id === null) return false;                                    // no connection
    var the_link = app.graph.links[link_id];
    if (!the_link) return false; 
    if (treat_bypassed_as_live) return true;
    the_link = handle_bypass(the_link, the_link.type);                       // find the link upstream of bypasses
    if (!the_link) return false;                                           // no source for data.
    return true;
}

/*
Is this a UE node?
*/
function is_UEnode(node_or_nodeType) {
    const title = node_or_nodeType.type || node_or_nodeType.comfyClass;
    return ((title) && (title.startsWith("Anything Everywhere") || title==="Seed Everywhere" || title==="Prompts Everywhere"))
}
function is_helper(node_or_nodeType) {
    const title = node_or_nodeType.type || node_or_nodeType.comfyClass;
    return ((title) && (title.startsWith("Simple String")))
}
function has_priority_boost(node_or_nodeType) {
    const title = node_or_nodeType.type || node_or_nodeType.comfyClass;
    return ((title) && (title == "Anything Everywhere?"))   
}

/*
Inject a call into a method on object with name methodname.
The injection is added at the end of the existing method (if the method didn't exist, it is created)
injectionthis and injectionarguments are passed into the apply call (as the this and the arguments)
*/
function inject(object, methodname, tracetext, injection, injectionthis, injectionarguments) {
    const original = object[methodname];
    object[methodname] = function() {
        original?.apply(this, arguments);
        injection.apply(injectionthis, injectionarguments);
    }
}


export { node_in_loop, handle_bypass, node_is_live, is_connected, is_UEnode, is_helper, inject, Logger, get_real_node, get_group_node, get_all_nodes_within, has_priority_boost}

export function defineProperty(instance, property, desc) {
    const existingDesc = Object.getOwnPropertyDescriptor(instance, property);
    if (existingDesc?.configurable === false) {
      throw new Error(`Error: Cannot define un-configurable property "${property}"`);
    }
    if (existingDesc?.get && desc.get) {
      const descGet = desc.get;
      desc.get = () => {
        existingDesc.get.apply(instance, []);
        return descGet.apply(instance, []);
      };
    }
    if (existingDesc?.set && desc.set) {
      const descSet = desc.set;
      desc.set = (v) => {
        existingDesc.set.apply(instance, [v]);
        return descSet.apply(instance, [v]);
      };
    }
    desc.enumerable = desc.enumerable ?? existingDesc?.enumerable ?? true;
    desc.configurable = desc.configurable ?? existingDesc?.configurable ?? true;
    if (!desc.get && !desc.set) {
      desc.writable = desc.writable ?? existingDesc?.writable ?? true;
    }
    return Object.defineProperty(instance, property, desc);
  }

export class Pausable {
    constructor(name) {
        this.name = name
        this.pause_depth = 0
    }
    pause(note, ms) {
        this.pause_depth += 1;
        if (this.pause_depth>10) {
            Logger.log_error(`${this.name} Over pausing`)
        }
        Logger.log_detail(`${this.name} pause ${note} with ${ms}`)
        if (ms) setTimeout( this.unpause.bind(this), ms );
    }
    unpause() { 
        this.pause_depth -= 1
        Logger.log_detail(`${this.name} unpause`)
        if (this.pause_depth<0) {
            Logger.log_error(`${this.name} Over unpausing`)
            this.pause_depth = 0
        }
    this.on_unpause()
    }
    paused() {
        return (this.pause_depth>0)
    }
    on_unpause(){}
}