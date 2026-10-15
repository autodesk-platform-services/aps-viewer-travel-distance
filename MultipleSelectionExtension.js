const MultiSelectionToolToolName = 'multi-selection-tool';

class MultiSelectionTool extends Autodesk.Viewing.ToolInterface {
  constructor(viewer) {
    super();
    this.viewer = viewer;
    this.names = [MultiSelectionToolToolName];
    this.selection = [];
    this.active = false;
    // Hack: delete functions defined on the *instance* of a ToolInterface (we want the tool controller to call our class methods instead)
    delete this.register;
    delete this.deregister;
    delete this.activate;
    delete this.deactivate;
    delete this.getPriority;
    delete this.handleSingleClick;
  }

  register() {
      console.log('MultiSelectionTool registered.');
  }

  deregister() {
      console.log('MultiSelectionTool unregistered.');
  }

  activate() {
      if (!this.active) {
          console.log('MultiSelectionTool activated.');
          this.active = true;
      }
  }

  deactivate() {
      if (this.active) {
          this.active = false;
      }
  }

  getPriority() {
      return 99; // Feel free to use any number higher than 0 (which is the priority of all the default viewer tools)
  }

  handleSingleClick(event, button) {
      const currentSelection = this.viewer.getSelection();
      //check if ctrl key is pressed
      if (event.ctrlKey) {
          this.selection.push(...currentSelection)
      }
      else{
        const castResult = this.viewer.clientToWorld(event.canvasX, event.canvasY);
        this.selection = !!castResult?.dbId? [castResult.dbId]: []; // Reset the selection if ctrl key is not pressed
      }
      this.viewer.select(this.selection); 
      //Return true so it doesn't call the default behavior of the viewer (which is to select the object under the mouse cursor)
      return true;
  }
}

class MultiSelectionExtension extends Autodesk.Viewing.Extension {
  constructor(viewer, options) {
    super(viewer, options);
    this.tool = new MultiSelectionTool(viewer);
  }

  async load() {
    const controller = this.viewer.toolController;
    this.viewer.toolController.registerTool(this.tool);
    controller.activateTool(MultiSelectionToolToolName);
    return true;
  }

  unload() {
    const controller = this.viewer.toolController;
    controller.deactivateTool(MultiSelectionToolToolName);
    return true;
  }
}

Autodesk.Viewing.theExtensionManager.registerExtension('MultiSelectionExtension', MultiSelectionExtension);